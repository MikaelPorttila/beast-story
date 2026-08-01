/// <reference types="vite/client" />

// What this buys, and why it is a file rather than a "types" entry in
// tsconfig.json: it declares the ambient module shapes for Vite's asset imports
// (`import url from './menu-bg.webp'` is a string), plus `import.meta.env`.
// Adding "types": ["vite/client"] to tsconfig instead would ALSO narrow the set
// of global @types packages the compiler picks up, which is a much larger
// change than the one intended here. This is the shape Vite's own docs use.
