import fs from "node:fs";
import path from "node:path";

const BASE = "https://registry.cloudflare.com";
const REPO = "f3adabb2e83104cf7b9c244077547991/spike-5a-spike5asandbox";
const DIR = "tmp/img";
const CHUNK = 4 * 1024 * 1024;

const cred = JSON.parse(fs.readFileSync(".secret-regcred.json", "utf8"));
const AUTH = "Basic " + Buffer.from(`${cred.Username}:${cred.Secret}`).toString("base64");

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"))[0];
const unique = [...new Set([manifest.Config, ...manifest.Layers])];

const abs = (loc) => (loc.startsWith("http") ? loc : BASE + loc);

async function head(digest) {
	const r = await fetch(`${BASE}/v2/${REPO}/blobs/sha256:${digest}`, {
		method: "HEAD",
		headers: { Authorization: AUTH },
	});
	return r.status;
}

async function uploadOffset(loc) {
	const r = await fetch(loc, { headers: { Authorization: AUTH } });
	if (r.status === 204 || r.status === 200) {
		const range = r.headers.get("range"); // e.g. "0-1048575" or "bytes=0-1048575"
		if (range) {
			const m = range.match(/(\d+)-(\d+)/);
			if (m) return parseInt(m[2]) + 1;
		}
		return 0;
	}
	return null; // session gone
}

async function upload(digest, file) {
	const size = fs.statSync(file).size;
	const fd = fs.openSync(file, "r");
	let res = await fetch(`${BASE}/v2/${REPO}/blobs/uploads/`, {
		method: "POST",
		headers: { Authorization: AUTH },
	});
	if (res.status !== 202) throw new Error(`POST ${res.status} ${await res.text()}`);
	let loc = abs(res.headers.get("location"));
	let off = 0;
	while (off < size) {
		const end = Math.min(off + CHUNK, size) - 1;
		const buf = Buffer.alloc(end - off + 1);
		fs.readSync(fd, buf, 0, buf.length, off);
		try {
			res = await fetch(loc, {
				method: "PATCH",
				headers: {
					Authorization: AUTH,
					"Content-Type": "application/octet-stream",
					"Content-Range": `${off}-${end}`,
				},
				body: buf,
			});
			if (res.status !== 202) throw new Error(`status ${res.status}`);
			loc = abs(res.headers.get("location"));
			off = end + 1;
		} catch (e) {
			// find where the registry thinks we are and resume
			const cur = await uploadOffset(loc);
			if (cur === null) {
				res = await fetch(`${BASE}/v2/${REPO}/blobs/uploads/`, {
					method: "POST",
					headers: { Authorization: AUTH },
				});
				if (res.status !== 202) throw new Error(`rePOST ${res.status}`);
				loc = abs(res.headers.get("location"));
				off = 0;
			} else {
				off = cur;
			}
			process.stdout.write(`\nretry at ${off} (${e.message}) `);
		}
		process.stdout.write(`\r${digest.slice(0, 12)} ${((off / size) * 100).toFixed(0)}%`);
	}
	fs.closeSync(fd);
	const sep = loc.includes("?") ? "&" : "?";
	res = await fetch(`${loc}${sep}digest=sha256:${digest}`, {
		method: "PUT",
		headers: { Authorization: AUTH },
	});
	if (res.status !== 201) throw new Error(`PUT ${res.status} ${await res.text()}`);
	console.log(`\nuploaded ${digest} (${size} bytes)`);
}

for (const b of unique) {
	const digest = b.replace("blobs/sha256/", "");
	const st = await head(digest);
	if (st === 200) {
		console.log(`exists ${digest.slice(0, 12)}`);
		continue;
	}
	await upload(digest, path.join(DIR, b));
}
console.log("done");
