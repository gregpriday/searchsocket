/**
 * Stand-in for `$app/navigation` so the generated templates can be mounted
 * outside a SvelteKit app. Tests import `navigations` to assert where a
 * selection sent the user.
 */
export const navigations: string[] = [];

export async function goto(url: string): Promise<void> {
  navigations.push(url);
}

export function resetNavigations(): void {
  navigations.length = 0;
}
