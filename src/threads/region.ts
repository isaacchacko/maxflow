const lastClickedOrFocused = { region: "main" };
const regionOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-region]")?.dataset["region"] : undefined) ?? "main";
const followRegion = (e: Event) => {
  lastClickedOrFocused.region = regionOf(e.target);
};
addEventListener("pointerdown", followRegion, true);
addEventListener("focusin", followRegion, true);
export const activeRegion = () => lastClickedOrFocused.region;
export const focusRegion = (region: string) => {
  lastClickedOrFocused.region = region;
};
