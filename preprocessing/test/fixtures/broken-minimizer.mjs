// test only: replace webpack's minimizer plugin with a broken one, like a damaged node_modules
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "minimizer-webpack-plugin" || spec === "terser-webpack-plugin")
    return { url: "data:text/javascript," + encodeURIComponent("export default class { constructor() { throw new TypeError('getImplementationModuleRef is not a function'); } }"), shortCircuit: true };
  return next(spec, ctx);
}`));
