import { Icon } from "./Icon";
import { SearchField as HeroSearchField } from "@heroui/react/search-field";
import type { Ref } from "react";

export function SearchField({
  label,
  placeholder,
  maxLength,
  ref,
  classes,
}: {
  label: string;
  placeholder: string;
  maxLength: number;
  ref: Ref<HTMLInputElement>;
  classes: { field: string; input: string; searchIcon: string };
}) {
  return (
    <HeroSearchField aria-label={label} className={classes.field}>
      <Icon name="search" className={classes.searchIcon} />
      <HeroSearchField.Input
        ref={ref}
        placeholder={placeholder}
        maxLength={maxLength}
        className={classes.input}
      />
    </HeroSearchField>
  );
}
