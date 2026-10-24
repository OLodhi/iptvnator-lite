// Test-only stand-in for SvelteKit's $app/state; tests replace it with vi.mock.
export const page = { params: {} as Record<string, string>, url: new URL('http://localhost/') };
