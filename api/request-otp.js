const https = require("https");
const zlib = require("zlib");

function parseCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.split('=');
    if (!key) return acc;
    acc[key.trim()] = rest.join('=').trim();
    return acc;
  }, {});
}

function makeHttpsRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      method: options.method || "GET",
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: options.headers || {},
      rejectUnauthorized: false
    };

    const req = https.request(reqOptions, (res) => {
      let chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"];

        if (encoding === "gzip") {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ status: res.statusCode, headers: res.headers, body: decoded });
          });
        } else if (encoding === "deflate") {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ status: res.statusCode, headers: res.headers, body: decoded });
          });
        } else if (encoding === "br") {
          zlib.brotliDecompress(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ status: res.statusCode, headers: res.headers, body: decoded });
          });
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: buffer });
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (options.timeout) {
      req.setTimeout(options.timeout, () => {
        req.destroy(new Error(`Request timed out after ${options.timeout}ms`));
      });
    }

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, captcha-code, Captcha-Code, x-captcha-session, X-Captcha-Session");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const captchaCode = req.headers["captcha-code"] || req.headers["Captcha-Code"];
  if (!captchaCode) {
    return res.status(400).json({ error: "Captcha-Code header is required" });
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionCookie = req.headers["x-captcha-session"] || req.headers["X-Captcha-Session"] || cookies['captcha-session'];

  const { fullName, fullNameLoc, dobLoc, ccnIssuingDateLoc } = req.body;
  if (!fullName || !fullNameLoc || !dobLoc || !ccnIssuingDateLoc) {
    return res.status(400).json({ error: "Missing required body fields" });
  }

  const targetUrl = "https://api-citizenportal.donidcr.gov.np/api/v1/mfa/request-otp";
  const postPayload = JSON.stringify({ fullName, fullNameLoc, dobLoc, ccnIssuingDateLoc });

  try {
    const requestHeaders = {
      "Host": "api-citizenportal.donidcr.gov.np",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postPayload),
      "Captcha-Code": captchaCode,
      "Origin": "https://citizenportal.donidcr.gov.np",
      "Referer": "https://citizenportal.donidcr.gov.np/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Connection": "keep-alive"
    };

    if (sessionCookie) {
      requestHeaders.Cookie = Buffer.from(sessionCookie, 'base64').toString('utf8');
    }

    const result = await makeHttpsRequest(targetUrl, {
      method: "POST",
      headers: requestHeaders,
      timeout: 30000
    }, postPayload);

    const bodyText = result.body.toString("utf8");
    let responseBody = bodyText;
    try {
      responseBody = JSON.parse(bodyText);
    } catch (e) {
      // Keep raw text if JSON parse fails
    }

    res.status(result.status);
    res.setHeader("Content-Type", "application/json");
    return res.json(responseBody);
  } catch (error) {
    console.error("OTP request error:", error);
    if (error.code === "ENETUNREACH") {
      return res.status(503).json({
        error: "The OTP provider is currently unreachable from the application server. Please try again later."
      });
    }
    return res.status(500).json({ error: `OTP request failed: ${error.message}` });
  }
};
