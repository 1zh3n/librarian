# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp==1.30.0"]
# ///
"""Run an OAuth/PKCE smoke test against a disposable local Librarian debug binary."""
import asyncio
import base64
import importlib.metadata
from hashlib import sha256
from io import BytesIO
import json
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from zipfile import ZipFile
from urllib.parse import parse_qs, parse_qsl, urljoin, urlsplit

import httpx
from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientMetadata


class MemoryStorage:
    tokens = None
    client_info = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client_info

    async def set_client_info(self, client_info):
        self.client_info = client_info


def operation():
    return str(uuid.uuid4())


async def exercise(origin, password, admin):
    storage = MemoryStorage()
    callback = asyncio.get_running_loop().create_future()

    async def receive(reader, writer):
        request_line = (await reader.readline()).decode("ascii")
        pairs = parse_qs(urlsplit(request_line.split()[1]).query)
        callback.set_result((pairs["code"][0], pairs["state"][0]))
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async with await asyncio.start_server(receive, "127.0.0.1", 0) as listener, httpx.AsyncClient(trust_env=False, timeout=45) as browser:
        redirect = f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}/callback"

        async def authorize(url):
            login = await browser.get(url)
            assert login.is_redirect
            login_url = urljoin(origin, login.headers["location"])
            assert login_url.startswith(origin + "/")
            signed_in = await browser.post(login_url, headers={"Origin": origin},
                data={"username": "member", "password": password})
            assert signed_in.is_redirect
            form = (await browser.get(url)).raise_for_status().text
            csrf = re.search(r'name="csrf_token" value="([^"]+)"', form).group(1)
            fields = dict(parse_qsl(urlsplit(url).query))
            fields.update(csrf_token=csrf, decision="approve", space="sample")
            consent = await browser.post(url, headers={"Origin": origin}, data=fields)
            assert consent.is_redirect
            location = consent.headers["location"]
            assert location.startswith(redirect + "?")
            (await browser.get(location)).raise_for_status()

        async def wait_callback():
            return await asyncio.wait_for(callback, 15)

        endpoint = origin + "/.mcp"
        oauth = OAuthClientProvider(endpoint, OAuthClientMetadata(
            client_name="Librarian local smoke", redirect_uris=[redirect],
            token_endpoint_auth_method="none", scope="mcp"), storage, authorize, wait_callback)
        async with httpx.AsyncClient(auth=oauth, trust_env=False, timeout=45) as http:
            async with streamable_http_client(endpoint, http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = {t.name for t in (await session.list_tools()).tools}
                    assert len(tools) == 18

                    async def call(name, args):
                        response = await session.call_tool(name, args)
                        assert not response.isError, (name, response.structuredContent)
                        return response.structuredContent

                    workspace = (await call("workspace_list", {}))["workspaces"][0]["id"]
                    args = {"workspaceId": workspace, "operationId": operation(), "targetDirectory": "项目甲",
                        "files": [{"path": name, "contentBase64": base64.b64encode(body).decode("ascii")}
                                  for name, body in [("方案.md", "# 河流\r\n![图](图.png)\r\n".encode()), ("图.png", b"fixture")]]}
                    receipt = await call("workspace_upload_files", args)
                    assert await call("workspace_upload_files", args) == receipt
                    document = receipt["documents"][0]
                    assert document["readerUrl"] == origin + document["readerPath"]
                    (await browser.get(document["readerUrl"])).raise_for_status()
                    binary_edit = {"workspaceId":workspace, "operationId":operation(), "targetDirectory":"项目甲",
                        "files":[{"path":"图.png","contentBase64":base64.b64encode(b"replacement").decode("ascii")}],
                        "updates":[{"path":"图.png","baseRevision":sha256(b"fixture").hexdigest()}]}
                    await call("workspace_upload_files",binary_edit)
                    asset = origin + f"/api/v1/workspaces/{workspace}/assets/项目甲/图.png"
                    assert (await browser.get(asset)).raise_for_status().content == b"replacement"
                    await call("workspace_undo_operation", {"workspaceId":workspace,"operationId":binary_edit["operationId"]})
                    assert (await browser.get(asset)).raise_for_status().content == b"fixture"
                    zip_buffer = BytesIO()
                    with ZipFile(zip_buffer,"w") as archive:
                        archive.writestr("附记.md","附记内容\r\n".encode())
                    imported = await browser.post(origin+f"/api/v1/workspaces/{workspace}/imports",
                        headers={"Origin":origin},json={"targetDirectory":"归档","operationId":operation(),
                        "archiveBase64":base64.b64encode(zip_buffer.getvalue()).decode("ascii")})
                    assert imported.raise_for_status().json()["documents"][0]["path"] == "归档/附记.md"
                    saved = await browser.get(f"{origin}/api/v1/workspaces/{workspace}/imports/{args['operationId']}")
                    assert saved.raise_for_status().json() == receipt
                    for _ in range(100):
                        hits = await call("document_search", {"workspaceId":workspace, "query":"河流"})
                        if any(hit["document"]["id"] == document["documentId"] for hit in hits["hits"]):
                            break
                        await asyncio.sleep(0.2)
                    else:
                        raise AssertionError("Search did not return the uploaded document")
                    original = await call("document_read", {"documentId":document["documentId"]})
                    assert original["markdown"].startswith("# 河流")
                    batch = {"operationId":operation(), "workspaceId":workspace}
                    changed = await call("workspace_apply_edits", {**batch, "edits":[{
                        "documentId":document["documentId"], "baseRevision":original["revision"], "markdown":"修改\n"}]})
                    assert changed["commitId"] == (await call("workspace_get_operation",batch))["commitId"]
                    await call("workspace_undo_operation",batch)
                    restored = await call("document_read", {"documentId":document["documentId"]})
                    assert restored["markdown"] == original["markdown"]
                    single = await call("document_create", {"workspaceId": workspace, "operationId": operation(),
                        "path":"另一份.md", "markdown":"附件说明"})
                    assert single["readerUrl"] == origin + single["readerPath"]
                    updated = await call("document_update", {"documentId":single["documentId"], "operationId":operation(),
                        "baseRevision":single["changes"][0]["revision"], "markdown":"更新说明"})
                    assert updated["readerUrl"] == single["readerUrl"] and updated["path"] == "另一份.md"
                    delete = {"workspaceId":workspace, "operationId":operation()}
                    plan = await call("workspace_request_reorganization",{**delete,"request":{
                        "kind":"delete", "documentIds":[single["documentId"]]}})
                    approve = await browser.post(origin + "/api/v1/ai/operations/" + delete["operationId"] + "/confirm",
                        headers={"Origin":origin}, json={"confirmationId":plan["confirmation"]["id"]})
                    assert approve.raise_for_status().json()["status"] == "succeeded"
                    await call("workspace_undo_operation",delete)
                    assert (await call("document_read",{"documentId":single["documentId"]}))["markdown"] == "更新说明"
                    pending = {"workspaceId": workspace, "operationId": operation()}
                    preview = await call("workspace_request_reorganization", {**pending,"request":{
                        "kind":"delete","documentIds":[document["documentId"]]}})
                    assert preview["status"] == "needs_confirmation"
                    access = storage.tokens.access_token
                    revoke = await browser.post(origin + "/.auth/revoke", data={
                        "token":storage.tokens.refresh_token,"client_id":storage.client_info.client_id})
                    revoke.raise_for_status()
                    confirm = await browser.post(origin + "/api/v1/ai/operations/" + pending["operationId"] + "/confirm",
                        headers={"Origin":origin}, json={"confirmationId":preview["confirmation"]["id"]})
                    assert confirm.status_code in (403,404)
                    refused = await browser.post(endpoint, headers={"Authorization": "Bearer " + access,
                        "Accept": "application/json, text/event-stream"}, json={
                        "jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})
                    assert refused.status_code == 401
                    removed = await admin.request("DELETE",origin + f"/api/v1/workspaces/{workspace}/members/member",
                        headers={"Origin":origin},json={})
                    removed.raise_for_status()
                    denied = await browser.get(origin + "/api/v1/documents/" + document["documentId"])
                    assert denied.status_code == 404
                    print(f"Python MCP SDK {importlib.metadata.version('mcp')}, {len(tools)} tools, {len(hits['hits'])} search hits, OAuth revocation {refused.status_code}, Reader confirmation {confirm.status_code}, removed member {denied.status_code}")


async def main(binary):
    with tempfile.TemporaryDirectory(prefix="librarian-mcp-") as folder:
        root = Path(folder)
        password = secrets.token_urlsafe(32)
        subprocess.run([binary, "--data-root",folder,"init","--username","admin"],
                       input=password+"\n",text=True,check=True,stdout=subprocess.DEVNULL)
        with socket.socket() as port:
            port.bind(("127.0.0.1",0))
            addr = f"127.0.0.1:{port.getsockname()[1]}"
        origin = "http://" + addr
        (root/"spaces/sample").mkdir(parents=True)
        (root/"spaces.json").write_text(json.dumps({"sample":{"name":"Sample","binding":{"prefix":"/sample"},
            "access":"none","members":{"admin":{"role":"write"}},"revisions":"managed"}}))
        (root/"server.json").write_text(json.dumps({"primaryUrl":origin, "mcp":True}))
        (root/".librarian/server.json").write_text(json.dumps({"publicReaderUrl":origin}))
        with subprocess.Popen([binary,"--data-root",folder,"--listen",addr],stdout=subprocess.DEVNULL) as server:
            try:
                async with httpx.AsyncClient(trust_env=False, timeout=45) as client:
                    for _ in range(100):
                        if server.poll() is not None:
                            raise RuntimeError("Librarian exited before startup")
                        try:
                            (await client.get(origin+"/api/v1/health")).raise_for_status()
                            break
                        except httpx.ConnectError:
                            await asyncio.sleep(0.1)
                    login = await client.post(origin+"/.auth/librarian/login",headers={"Origin":origin},
                        data={"username":"admin","password":password})
                    assert login.is_redirect
                    member_password = secrets.token_urlsafe(32)
                    (await client.post(origin+"/api/v1/accounts",headers={"Origin":origin},
                        json={"username":"member","password":member_password})).raise_for_status()
                    workspace=(await client.get(origin+"/api/v1/workspaces")).raise_for_status().json()[0]["id"]
                    (await client.put(origin+f"/api/v1/workspaces/{workspace}/members/member",
                        headers={"Origin":origin},json={"role":"write"})).raise_for_status()
                    await asyncio.wait_for(exercise(origin,member_password,client),150)
            finally:
                server.terminate()


if __name__ == "__main__":
    asyncio.run(main(str(Path(sys.argv[1]).resolve())))
