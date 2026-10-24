import argparse
import collections
import csv
import functools
import glob
import os
import random
import shutil
import subprocess
import tempfile


webpack_config_tmpl = r"""
var webpack = require("webpack");

module.exports = {
    mode: "production",
    devtool: "source-map",
    optimization: {
        usedExports: false,
        providedExports: false,
        sideEffects: false,
        minimize: true,
        splitChunks: false,
        runtimeChunk: false,
    },
    output: {
        path: "%outputpath%",
        filename: "%filename%"
    },
    module: {
        rules: [
            { 
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader'
            },
            {
                test: /\.css$/,
                exclude: /node_modules/,
                use: 'css-loader'
            },
            {
                test: /\.(ico|jpg|png|gif|eot|otf|webp|svg|ttf|woff|woff2)(\?.*)?$/,
                loader: 'file-loader',
                options: {
                  name: 'static/media/[name].[hash:8].[ext]'
                }
            }
        ]
    },
    plugins: [
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1,
        })
    ]
};
"""

__sample_packages_state = 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-o", "--output-dir", type=str, required=True)
    parser.add_argument("-n", "--number", type=int, required=True, help="Number of bundles to generate. If value is -1 and --one-for-each is set, auto-choose the correct value")
    parser.add_argument(
        "-p",
        "--packages",
        type=int,
        required=True,
        help="Number of packages per bundle",
    )
    parser.add_argument(
        "-1",
        "--one-for-each",
        action="store_true",
        help="Make sure every library's most recent version is in a bundle. The amount of bundles is still limited by -n",
    )
    args = parser.parse_args()

    npm_dir = os.getenv("NPM_DIR")

    def semver_conv(a):
        return tuple(map(int, a.split(".")))

    packageVersions = functools.reduce(
        lambda p, n: (p, p[n[0].replace("+", "/")].append(n[1]))[0],
        map(lambda e: e.rsplit("@", 1), os.listdir(npm_dir)),
        collections.defaultdict(list),
    )

    for pkg in packageVersions:
        packageVersions[pkg].sort(key=semver_conv, reverse=True)

    packages = sorted(packageVersions.keys())

    def sample_packages():
        if not args.one_for_each:
            pkgs = random.sample(packages, args.packages)
            return [(pkg, random.choice(packageVersions[pkg])) for pkg in pkgs]
        else:
            global __sample_packages_state
            fixed_pkg = (
                packages[__sample_packages_state]
                if __sample_packages_state < len(packages)
                else random.choice(packages)
            )
            __sample_packages_state += 1
            fixed = (fixed_pkg, packageVersions[fixed_pkg][0])
            pkgs = random.sample(packages, args.packages - 1) if args.packages > 1 else []
            return [fixed] + [(pkg, random.choice(packageVersions[pkg])) for pkg in pkgs]

    STORE_PATH = "/tmp/.pnpm-store/v3"
    META_PATH = "/tmp/lab-bundles-meta.csv"
    with open(META_PATH, "w") as f:
        # truncate file
        pass

    with tempfile.TemporaryDirectory() as tmp_dir:
        subprocess.run(
            [
                "pnpm",
                "config",
                "set",
                "store-dir",
                STORE_PATH,
            ],
            cwd=tmp_dir,
        )

        n = 0
        for _ in range(args.number if args.number > 0 or not args.one_for_each else len(packages)):
            if n % 500 == 250:
                # Regular cleanup
                shutil.rmtree(STORE_PATH, ignore_errors=True)

            bundle_contents = sample_packages()
            if not args.one_for_each:
                while os.path.exists(os.path.join(args.output_dir, f"bundle-{n:04}.js")):
                    n += 1
            else:
                with open(META_PATH, "a") as f:
                    csv.writer(f).writerow([n] + bundle_contents)

                if os.path.exists(os.path.join(args.output_dir, f"bundle-{n:04}.js")):
                    print("Skipping", bundle_contents[0])
                    n += 1
                    continue

            with open(os.path.join(tmp_dir, "webpack.config.js"), "w") as f:
                f.write(
                    webpack_config_tmpl.replace("%outputpath%", args.output_dir).replace(
                        "%filename%", f"bundle-{n:04}.js"
                    )
                )

            entrypoint = "\n".join([f"import * as pkg{i} from '{pv[0]}';" for i, pv in enumerate(bundle_contents)])

            with open(os.path.join(tmp_dir, "index.js"), "w") as f:
                f.write(entrypoint)

            try:
                subprocess.run(
                    [
                        "pnpm",
                        "install",
                        "-D",
                        "webpack",
                        "webpack-cli",
                    ],
                    cwd=tmp_dir,
                )
                subprocess.run(
                    [
                        "pnpm",
                        "install",
                        "--save-exact",
                        "--no-optional",
                        "--ignore-scripts",
                        "--config.confirmModulesPurge=false",
                    ]
                    + ["@".join(pv) for pv in bundle_contents],
                    cwd=tmp_dir,
                    stdin=subprocess.DEVNULL,
                    timeout=60
                )

                subprocess.run(
                    [
                        "npx",
                        "webpack",
                        "bundle",
                        "--entry",
                        "./index.js",
                        "--config",
                        "webpack.config.js",
                    ],
                    cwd=tmp_dir,
                    timeout=180
                )

                subprocess.run(
                    [
                        "pnpm",
                        "uninstall",
                    ]
                    + [pv[0] for pv in bundle_contents],
                    cwd=tmp_dir,
                    timeout=60
                )
            except subprocess.TimeoutExpired:
                # Cannot install automatically, so create empty placeholder file
                with open(os.path.join(args.output_dir, f"bundle-{n:04}.js"), "w") as f:
                    pass

            n += 1

