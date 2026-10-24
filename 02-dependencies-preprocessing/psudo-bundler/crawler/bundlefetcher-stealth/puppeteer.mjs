import {networkInterfaces} from 'node:os';
import process from 'node:process';
import {execSync} from 'node:child_process';

import * as puppeteer from 'puppeteer-real-browser';
import express from 'express';

const MAX_PARALLEL_COUNTER = Number.parseInt(process.env.MAX_PARALLEL_COUNTER ?? "30");
const TIMEOUT = Number.parseInt(process.env.TIMEOUT ?? "15000");
const EXTRA_TIMEOUT = Number.parseInt(process.env.TIMEOUT ?? "3000");

const JS_MIME_TYPES = ["application/javascript", "application/x-javascript", "text/javascript"];
const BLOCKED_MEDIA_TYPES = ["image", "media"];

let parallel_counter = 0;

const app = express();

let options = {
    headless: true,
};

let proxiedFetch = fetch;

if (process.env.SOCKS) {
    const nets = networkInterfaces();
    let ip = 0;
    for (const net in nets) {
        for (const info of nets[net]) {
            if (!info.internal && info.family === "IPv4") {
                ip = Number.parseInt(info.address.split(".").slice(-1)[0])
            }
        }
    }

    options.args = [
        `--proxy-server=socks5://host.docker.internal:${Number.parseInt(process.env.SOCKS) + ip % 6}`,
        "--disable-features=site-per-process",  // may help against Error: Navigating frame was detached
        "--disable-dev-shm-usage",  // may help against net::ERR_INSUFFICIENT_RESOURCES
        "--disk-cache-size=8388608",  // 8 MiB, may help against every Chrome instance taking 30+GB in disk space
    ];

    // Don't use proxied fetch as it may cause our scanning IPs to get flagged as bot
    //
    // proxiedFetch = (input, init) => {
    //     const agent = new SocksProxyAgent(`socks5://host.docker.internal:${Number.parseInt(process.env.SOCKS) + ip % 6}`);
    //     init = init ?? {};
    //     init.agent = agent;
    //     return nodeFetch(input, init);
    // }
}

const {browser} = await puppeteer.connect(options)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/fetch', (req, res) => {
    if (parallel_counter > MAX_PARALLEL_COUNTER) {
        res.sendStatus(429);
    }
    parallel_counter += 1;

    const url = req.query.url;
    puppeteerRequest(url).then(d => res.json(d)).catch(e => {
        res.status(500).json({"error": `${e}`});
        if (`${e.stack}`.includes("Connection closed")) {
            // Browser crashed and will not recover, restart script and browser
            browser
                .close()
                .finally(() => execSync("killall chrom"))
                .finally(() => sleep(500))
                .finally(process.exit(1));
        }
        console.error(e.stack);
    }).finally(() => parallel_counter -= 1);
});

// Some puppeteer startup time
sleep(2000).then(() => {
    app.listen(process.env.PORT ?? 5444, () => {
        console.log(`Puppeteer server listening on port ${process.env.PORT ?? 5444}`)
    });
});


async function puppeteerRequest(url) {
    const context = await browser.createBrowserContext();
    await sleep(500);
    const page = await context.newPage();
    await sleep(500);

    const results = [];
    const maps = new Map();

    page.on('request', async request => {
        if (BLOCKED_MEDIA_TYPES.includes(request.resourceType())) {
            await request.abort();
        } else {
            await request.continue();
        }
    });

    page.on('response', async response => {
        const method = response.request().method();
        const header = response.headers();
        if (method === "OPTIONS") {
            // Ignore CORS Preflight
            return;
        }

        if (response.status() >= 300 && response.status() < 400 && header.location) {
            // Remember we have been redirected
            results.push({
                url: response.url(),
                status: response.status(),
                location: header.location,
                type: "redirect",
            })
            return;
        }

        if (response.status() < 200 && response.status() >= 300) {
            // Ignore everything but successful responses
            return;
        }

        if (response.url().slice(0, 4) !== "http") {
            // Ignore data URLs
            return;
        }

        if (Number.parseInt(header["content-length"] ?? "0") === 0) {
            // Ignore empty responses
            return;
        }

        if (header["content-type"] === undefined) {
            console.warn("Unexpected headers", response.status(), response.url(), header);
        }

        if (maps.has(response.url())) {
            console.debug(`Loaded source map ${response.url()}`);
            const body = await response.text().catch(e => {
                console.warn(e);
                return "";
            });

            // Make sure, that source map is valid json
            try {
                JSON.parse(body);
            } catch (e) {
                return;
            }

            // Already stored
            const result = maps.get(response.url());
            result.sourceMapData = body;

        } else if (JS_MIME_TYPES.map(mt => (header["content-type"] ?? '').includes(mt)).some(v => v)) {
            let body = await response.text().catch(e => {
                console.warn(e);
                return "";
            });

            if (header.sourcemap) {
                // probably rare in practice
                body += `\n//# sourceMappingURL=${header.sourcemap}`;
            }
            const sourceMapData = getSourceMapData(body);

            const result = {
                url: response.url(),
                status: response.status(),
                type: "js",
                body,
            };

            if (sourceMapData.url) {
                if (!sourceMapData.url.includes("://")) {
                    // Resolve relative url
                    const baseurl = response.url().split("/").slice(0, -1).join("/");
                    sourceMapData.url = baseurl + "/" + sourceMapData.url;
                }

                maps.set(sourceMapData.url, () => result);

                await Promise.race([
                    proxiedFetch(sourceMapData.url),
                    new Promise((_, reject) => setTimeout(() => reject(), 2 * EXTRA_TIMEOUT))
                ]).then(async resp => {
                    if (resp.status >= 200 && resp.status < 300) {
                        const body = await resp.text();
                        try {
                            JSON.parse(body);
                            sourceMapData.data = body;
                        } catch (e) {
                            // console.log("Could not parse source map", sourceMapData.url, e, body)
                        }
                    }
                }).catch(
                    (e) => console.warn(`Could not fetch source map: ${sourceMapData.url.slice(0, 1024)}`, e)
                );
            } else if (sourceMapData.data) {
                // will be automatically saved below
            }
            console.debug(`Storing ${response.url()}`);

            result.sourceMapUrl = sourceMapData.url;
            result.sourceMapData = sourceMapData.data;
            results.push(result);

        } else if (response.url().endsWith(".map")) {
            console.error(`Mismatch: url=${response.url()}, maps=${JSON.stringify(maps)}`);
        } else {
            // console.debug(`Ignoring ${response.url()}`);
        }
    });

    await page.setRequestInterception(true);

    await page.goto(url, {timeout: TIMEOUT}).catch(e => {
        e = `${e}`;
        console.warn(url, e.split("\n")[0])
        console.warn(url, e.split("\n").splice(-1)[0])
    });

    await new Promise(resolve => setTimeout(resolve, EXTRA_TIMEOUT));

    await context.close();

    return results;
}

function getSourceMapData(js) {
    const inlineSourceMapString = "sourceMappingURL=data:application/json;charset=utf-8;base64,";
    const sourceMapReference = "\n//# sourceMappingURL=";

    let index;
    if ((index = js.indexOf(inlineSourceMapString)) >= 0) {
        const sourcemapB64 = js.slice(index + inlineSourceMapString.length);
        try {
            return {data: atob(sourcemapB64)};
        } catch (e) {
            return {error: `${e}`};
        }
    } else if ((index = js.indexOf(sourceMapReference)) >= 0) {
        return {url: js.slice(index + sourceMapReference.length).split("\n")[0].trim()};
    }
    return {};
}
