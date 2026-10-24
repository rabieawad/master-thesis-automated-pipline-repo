## Replication software for "Insecure Ingredients? Exploring Dependency Update Behavior of Bundled JavaScript Packages on the Web"

### Crawler

The crawler is built from a set of specific Docker containers communicating over a RabbitMQ instance.
All custom images require access to the Python package `pipeline-helper` which needs to be built separately.
The main crawling script is found in `bundlefetcher-stealth`.
The resulting data is spread over two locations.
All crawled JS files and source maps are written lzma-compressed to the object storage (file system) identified by the hash of the uncompressed contents for de-duplication.
The mapping of domains to stored objects is stored in the MongoDB container.


### Scripts

The algorithms are implemented in a mixture of Python and JavaScript.
Bundler fingerprints and preprocessing is found in `identification` along with `identification.mjs` as main script starting a web server to allow some part of the analysis in JavaScript.
`file_selector.mjs` includes the file selection algorithm and comes with a flow chart in `file_selection.pdf`.

You will need to set the `INDEX_DIR` variable appropriately. It is also recommended to extend the node heap space, for example through `NODE_OPTIONS="--max-old-space-size=32000"`.

For the analysis scripts, there are multiple variants:
- `local_version_fetcher.py`: Given a package lists, fetches all versions matching x.y.z
- `npm_mirror.py`: Store all `*js|*json` from all package versions in the input.
- `generate_bundles.py`: Generate lab bundles
- `pack_bundles.py`: Pack lab bundles into a dataset format compatible to the internet measurements
- `analyze_bundle_dataset.py`: Offers various analysis methods, but is not parallelized too well for many measurements
- `aletheia_speed_eval*.py`: Fastest analysis script, but specialized. The `recover` script is required to reverse the de-duplication during analysis.
- `vulnerability-database.py`: Scraper for Snyk, Github Advisories API (not recommended, clone the [repository](https://github.com/github/advisory-database) instead)


### Evaluation Notebooks

All Python notebooks used for evaluation are collected here.

#### BundlerStudy

As the implementation in their [Github repository](https://github.com/zenoj/BundlerStudy/) did not work out of the box, we fixed some issues and provide the updated version in this repository.

#### RQ1
- `bundler-prevalence.ipynb`: Prevalence of bundlers
- `cdn-urls.ipynb`: Prevalence of CDN URLs

#### RQ2
- `lab-bundler-study.ipynb`: Lab evaluation of BundlerStudy
- `real-bundler-study.ipynb`: Real-world evaluation of BundlerStudy
- `lab-aletheia.ipynb`: Lab evaluation of Aletheia
- `real-aletheia.ipynb`: Real-world evaluation of Aletheia

#### RQ3
- `update-patterns-cdn.ipynb`: Update pattern analysis for CDNs
- `update-patterns-pnpm.ipynb`: Update pattern analysis for pnpm
- `update-patterns-aletheia.ipynb`: Update patter analysis for all bundles with Aletheia

