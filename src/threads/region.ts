// With a thread open in the side pane beside the page, Escape and the composer's focus go to whichever of the two (data-region)
// he last clicked or focused.
let region = "main";
const regionOf = (el: Element | null | undefined) => el?.closest<HTMLElement>("[data-region]")?.dataset.region ?? "main";
for (const type of ["pointerdown", "focusin"]) addEventListener(type, e => (region = regionOf(e.target as Element)), true);
/** The region he is in: "main", or "pane" while he is in the side pane. */
export const activeRegion = () => region;
export const focusRegion = (r: string) => void (region = r);
