"""Aggregate blind council scores, excluding each judge's scores of its own ideas."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
MAPPING = json.loads((ROOT / "logs" / "_mapping.json").read_text())
JUDGES = {"S1": "A1", "S2": "A2", "S3": "A3", "S4": "A4", "S5": "A5"}
CRITERIA = ["wow", "mechanism", "useful", "scale", "feasibility", "not_median"]
ROW = re.compile(r"^\|\s*\**(I\d{2})\**\s*\|" + r"\s*([\d.]+)\s*\|" * 6)


def parse(path):
    scores = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = ROW.match(line)
        if m:
            scores[m.group(1)] = [float(x) for x in m.groups()[1:7]]
    return scores


def mentions(text, heading):
    m = re.search(rf"## {heading}(.*?)(\n## |\Z)", text, re.S)
    return set(re.findall(r"I\d{2}", m.group(1))) if m else set()


results = {iid: {"scores": [], "top5": 0, "kill": 0} for iid in MAPPING}
coverage = {}
for judge, author in JUDGES.items():
    files = list((ROOT / "scores").glob(f"{judge}-*.md"))
    if not files:
        continue
    text = files[0].read_text(encoding="utf-8")
    parsed = parse(files[0])
    coverage[judge] = len(parsed)
    for iid, vals in parsed.items():
        if iid in results and MAPPING[iid]["author"] != author:
            results[iid]["scores"].append(vals)
    for iid in mentions(text, "Top 5"):
        if iid in results and MAPPING[iid]["author"] != author:
            results[iid]["top5"] += 1
    for iid in mentions(text, "Kill list"):
        if iid in results and MAPPING[iid]["author"] != author:
            results[iid]["kill"] += 1

rows = []
for iid, r in results.items():
    n = len(r["scores"])
    if not n:
        continue
    means = [sum(s[i] for s in r["scores"]) / n for i in range(6)]
    rows.append((sum(means), iid, means, n, r["top5"], r["kill"]))
rows.sort(reverse=True)

print("coverage per judge:", coverage)
print(f"{'id':4} {'total':>5} " + " ".join(f"{c[:5]:>5}" for c in CRITERIA) + "  n top5 kill  author name")
for total, iid, means, n, top5, kill in rows:
    m = MAPPING[iid]
    print(f"{iid:4} {total:5.2f} " + " ".join(f"{x:5.2f}" for x in means)
          + f"  {n} {top5:4} {kill:4}  {m['author']}  {m['name']}")
