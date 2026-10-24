import ast
import os
import re
import statistics
import string

import semantic_version as sv

DATASETS = os.path.join(os.getenv("HOME", ".."), "datasets")
CDN_HOSTS = [
    "//cdn.jsdelivr.net",
    "//cdnjs.cloudflare.com",
    "//unpkg.com",
    "//ajax.googleapis.com",
    "//ajax.aspnetcdn.com",
    "//code.jquery.com",
]

def bundlers_to_set(bundlers):
    return set(b[0][:7] for b in bundlers)

def fix_libname(libname: str):
    if "@" in libname:
        return libname.replace("+", "/", 1)
    return libname

def parse_pnpm_names(name):
    names = []
    components = name.split("_")
    for component in components:
        if "@" in component:
            names.append(component.replace("+", "/"))
    return names

def parse_full_pnpm_names(full_name):
    names = []
    name = full_name.split(".pnpm/", 1)[-1].split("/", 1)[0]

    components = name.split("_")
    for component in components:
        if "@" in component:
            names.append(component.replace("+", "/"))
    return names

def get_version(pkg_at_version):
    return pkg_at_version.rsplit("@", 1)[-1]

def metric(similarity_dict):
    """
    Compute a similarity score

    :param similarity_dict: dict keys: "leftCovered", "leftTotal", "rightCovered", "rightTotal", "longest"
    :return: float
    """
    # return similarity_dict["rightCovered"] / similarity_dict["rightTotal"] if similarity_dict["rightTotal"] > 0 else 0
    return similarity_dict["leftCovered"] / similarity_dict["leftTotal"] if similarity_dict["leftTotal"] > 0 else 0

def semver_distance(u, v):
    v1, v2 = map(sv.Version.coerce, (u, v))
    return abs(v2.major - v1.major), abs(v2.minor - v1.minor), abs(v2.patch - v1.patch)

def semver_distance_list(v, l):
    return min([semver_distance(u, v) for u in l])

def extendReduce(p, c):
    p.extend(c)
    return p

def compute_statistics(l):
    return [min(l), statistics.median(l), statistics.mean(l), max(l)]

def extract_main_dependency_from_domain(domain):
    metastr = domain.split("/", 1)[-1]
    meta = ast.literal_eval(metastr)
    return ast.literal_eval(meta[1])


numbers_with_short_units = re.compile(r"^(-?[0-9]+[a-z]{0,3} *)+$")
_is_hinting_fingerprint_cache = {}

def is_hinting_fingerprint(s):
    if s in _is_hinting_fingerprint_cache:
        return _is_hinting_fingerprint_cache[s]

    # Ignore transition libraries https://easings.net/
    if "cubic-bezier(" in s:
        return True

    # Ignore colors
    if "rgba(" in s:
        return True

    # Ignore react-icons for MIT licensed in-sourced stuff
    # if "react-icons" in detected:
    #     continue

    # Ignore numbers with short units
    if re.match(r"^(-?[0-9]+[a-z]{0,3} *)+$", s):
        return False

    # The first two seem to be quite common selectors for all focusable elements
    if s in [
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        'button, [href], input, select, textarea, [tabindex="0"]',
        "input, select, textarea, button",
    ]:
        return True

    # Webpack-specific
    if s == "ES Modules may not assign module.exports or exports.*, Use ESM export syntax, instead: ":
        return True

    # Contained in official emoji list
    if s == "hamburger,meat,fast food,beef,cheeseburger,mcdonalds,burger king":
        return True

    return False

def fix_ground_truth(ground_truth, url, _fp):
    if len(list([p for p in ground_truth if "popper" in p])):  # Popper probably implies bootstrap
        ground_truth.add("bootstrap")
    if "swiper-bundle" in url:
        ground_truth.add("swiper")
    if "instantsearch" in url:
        ground_truth.add("instantsearch.js")
    if "feather" in url:
        ground_truth.add("feather-icons")
    if "/firebasejs/" in url:  # firebase as first party
        ground_truth.add("firebase")
        ground_truth.add("@firebase/component")
        ground_truth.add("@firebase/util")
        file = url.rsplit("/", 1)[1]
        m = re.match("firebase-([a-z-]+).js", file)
        if m:
            ground_truth.add(f"@firebase/{m.group(1)}")
        m = re.match("firebase-([a-z]+)-compat.js", file)
        if m:
            ground_truth.add(f"@firebase/{m.group(1)}")
    # if "@firebase/installations" in detected and "firebase" in url:
    #     # todo confirm this is really correct
    #     ground_truth.add("@firebase/installations")
    # if "@firebase/messaging" in detected:
    #     # todo confirm this is correct
    #     ground_truth.add("@firebase/messaging")
    # if "react-firebase-hooks" in detected:
    #     # react-firebase-hooks bundles its peer dependencies
    #     ground_truth.add("react-firebase-hooks")
    if "@zig-design-system/ui-components" in ground_truth:
        # bundled dependency in private package
        ground_truth.add("bind-decorator")
    if len(list([p for p in ground_truth if "@sentry/" in p])) > 0:
        # sentry tracing seems to be available in all
        ground_truth.add("@sentry/tracing")

CDN_REGEXS = [
    [
        re.compile(r"//cdn\.jsdelivr\.net/npm/(?P<lib>[^/@]+)/?$"),
        re.compile(r"//cdn\.jsdelivr\.net/npm/(?P<lib>[^/@]+)@(?P<vers>[^/@?]+)"),
        re.compile(r"//cdn\.jsdelivr\.net/npm/(?P<lib>@[^/@]+/[^/@]+)/?$"),
        re.compile(r"//cdn\.jsdelivr\.net/npm/(?P<lib>@[^/@]+/[^/@]+)@(?P<vers>[^/@?]+)"),
    ],
    [re.compile(r"//cdnjs\.cloudflare\.com/ajax/libs/(?P<lib>[^/]+)/(?P<vers>[^/?]+)")],
    [
        re.compile(r"//unpkg\.com/(?P<lib>[^/@]+)/?$"),
        re.compile(r"//unpkg\.com/(?P<lib>@[^/@]+/[^/@]+)/?$"),
        re.compile(r"//unpkg\.com/(?P<lib>[^/@]+)@(?P<vers>[^/@?]+)"),
        re.compile(r"//unpkg\.com/(?P<lib>@[^/@]+/[^/@]+)@(?P<vers>[^/@?]+)"),
    ],
    [re.compile(r"//ajax\.googleapis\.com/ajax/libs/(?P<lib>[^/]+)/(?P<vers>[^/?]+)")],
    [
        re.compile(r"//ajax.aspnetcdn.com/ajax/(?P<lib>[^/]+)/.+-(?P<vers>[^/\.?]+)"),
        re.compile(r"//ajax.aspnetcdn.com/ajax/(?P<lib>[^/]+)/(?P<vers>[^/?]+)"),
    ],
    [
        re.compile(r"//code\.jquery\.com/(?P<lib>[^/]+)-(?P<vers>[^/]+)\.min\.js"),
        re.compile(r"//code\.jquery\.com/ui/(?P<vers>[^/]+)/(?P<lib>[^/\.]+)"),
    ],
]

def get_library_version_from_cdn_url(url):
    for cdn_host, regexes in zip(CDN_HOSTS, CDN_REGEXS):
        if cdn_host in url:
            for regex in regexes:
                match = regex.search(url)
                if match:
                    d = match.groupdict()
                    return d.get("lib", "").lower(), d.get("vers", "*")

    return None

_strip_leading_zeroes = re.compile(r"(-.+[^0-9])0+([1-9])")

def coerce_version(v):
    if all(d not in v for d in string.digits):
        return sv.Version.coerce(f"0-{v}")

    while v[0] not in string.digits:
        v = v[1:]

    v = _strip_leading_zeroes.sub(r"\1\2", v)

    return sv.Version.coerce(v)


__all__ = [
    "DATASETS",
    "CDN_HOSTS",
    "bundlers_to_set",
    "fix_libname",
    "parse_pnpm_names",
    "parse_full_pnpm_names",
    "get_version",
    "metric",
    "semver_distance",
    "semver_distance_list",
    "extendReduce",
    "compute_statistics",
    "extract_main_dependency_from_domain",
    "is_hinting_fingerprint",
    "fix_ground_truth",
    "get_library_version_from_cdn_url",
    "coerce_version",
]
