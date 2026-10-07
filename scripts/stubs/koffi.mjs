// Stand-in for `koffi` inside the bundled Copilot SDK.
//
// The SDK only reaches koffi (a native FFI library with per-platform binaries)
// when a host embeds the Copilot runtime in-process. Roundtable always talks to
// the user's `copilot` CLI over stdio, so that code path is never taken; this
// stub keeps the native dependency out of the package and fails loudly if the
// path is ever hit.
const unsupported = () => {
  throw new Error('Roundtable runs the Copilot CLI over stdio; the in-process FFI runtime host is not available.');
};

const koffi = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === 'then' ? undefined : unsupported),
  },
);

export default koffi;
