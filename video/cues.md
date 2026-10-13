# Narration cue sheet

Silent 1080p demo. Read calmly; leave pauses between cues. Timings below come from this capture, not an illustrative replay.

| Start | Segment | On screen | Suggested narration |
|---|---|---|---|
| 00:00 | title | Agent Reorder Buffer — HTML card | This is Agent Reorder Buffer: out-of-order execution for coding agents, built on Cloudflare. |
| 00:08 | problem | Integration starts too late — HTML card | Merge queues speculate over finished pull requests. This project moves coordination earlier: consumers can begin while their producer is still working. |
| 00:33 | mechanism | Four mechanisms. One buffer. — HTML card | Forward the producer’s unfinished fork. Squash consumers when an interface changes. Use Jev to judge same-signature behavior changes. Then run tests in Dynamic Workers and retire in dependency order, by fast-forward or path-disjoint splice. There is no textual merge. |
| 01:18 | main | Live public dashboard | This is the live public dashboard at normal speed. The agents are scripted; forks, hashing, semantic judgments, tests and retirement are real. |
| 01:36 | main beat | Stub prediction: UI starts before the API exists | The UI starts before the API implementation exists, using a predicted interface. |
| 01:57 | main beat | Body-only refactor → early cutoff (Jev p=0.02) | Jev scores this refactor zero point zero two. Consumers keep their work. |
| 02:13 | main beat | Same signature, behavior changed → Jev p=0.94/0.97 → SQUASH | The signature stayed the same, but behavior changed. Jev scores zero point nine four and zero point nine seven; both consumers are squashed. |
| 02:28 | main beat | Signature changed → SQUASH + re-fork | Now the signature changes. Consumers are squashed and re-forked from the new producer head. |
| 02:43 | main beat | Retired in order onto trunk | All three entries have now retired in dependency order. |
| 02:48 | failing-check | Live public dashboard · 1.5× | This second live run is shown at one and a half times speed. A real failing test prevents retirement. Watch the scripted agent fix its assertion, then the checks run again. |
| 03:39 | failing-check beat | Check fails; scripted fix begins 0.2 seconds later | A real check fails. The agent immediately fixes it, and real checks run again. |
| 03:46 | multi | Live public dashboard · 1.5× | Two independent chains now share the same trunk. Each component makes progress without waiting for the other component’s head. Retirement onto trunk is still serialized. |
| 04:24 | multi beat | Two independent chains · no head-of-line blocking | Payments retire while orders are still running. This later-sequence consumer did not wait for the other component’s head. |
| 04:42 | mcp | Live public dashboard | This scene uses the actual stdio MCP server and a scripted MCP client. Register creates a real fork and local workspace. Push sends a real commit. Ready runs real checks before the entry retires. No tool output is invented. |
| 05:22 | numbers | Measured, not simulated — HTML card | Earlier runs re-forked in two point three to four point five seconds. Retirement was roughly half a second by fast-forward, or one point one seconds by splice. Jev scores point zero two versus point nine three to point nine seven. The synthetic, same-machine state-machine benchmark shows a higher version two median, with the ninety-fifth percentile almost flat. |
| 05:52 | closing | Repository URL: https://github.com/lautaroalejo02/cloudflare-challenge-build-next-gh | The code, evidence and rebuild instructions are in this repository. |

## Add your voice track

```sh
ffmpeg -i video/out/arb-demo-1080p.mp4 -i voice.m4a -c:v copy -c:a aac -shortest video/out/arb-demo-final.mp4
```
