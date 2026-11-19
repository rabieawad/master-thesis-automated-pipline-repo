// test only: make deleting good-lib's working folder fail with EIO, like a failing drive
import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const real = fs.rmSync;
fs.rmSync = (p, o) => { if (/_stream\/good-lib$/.test(String(p))) { const e = new Error(`Unknown error: Input/output error '${p}'`); e.code = ""; e.errno = -4094; e.syscall = "rm"; throw e; } return real(p, o); };
syncBuiltinESMExports();
