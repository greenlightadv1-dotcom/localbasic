/**
 * Stand-in for the `server-only` package under vitest.
 *
 * `server-only` has no Node entry point — it exists so that importing a server
 * module from client code is a bundler error. Vitest is neither, so it simply
 * cannot resolve it. Aliasing it to this empty module lets a unit test import
 * a server module directly; the real guard still applies to every Next build.
 */
export {};
