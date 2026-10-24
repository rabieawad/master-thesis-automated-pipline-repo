import http from "http";
import { URL } from "url";

// Polyfill
export default {
    serve({ port, fetch }) {
        if (typeof fetch !== "function") {
            throw new Error("fetch must be a function");
        }

        const server = http.createServer(async (req, res) => {
            try {
                const requestUrl = new URL(req.url, `http://${req.headers.host}`);
                const request = new Request(requestUrl, {
                    method: req.method,
                    headers: req.headers,
                    body: req.method !== "GET" && req.method !== "HEAD" ? req : null,
                    duplex: "half",
                });

                const response = await fetch(request);

                res.statusCode = response.status;
                for (const [key, value] of response.headers) {
                    res.setHeader(key, value);
                }
                const responseBody = await response.text();
                res.end(responseBody);
            } catch (error) {
                console.error("Error handling request:", error);
                res.statusCode = 500;
                res.end("Internal Server Error");
            }
        });

        server.listen(port);
    },
};
