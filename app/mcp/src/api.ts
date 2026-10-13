import { ApiClient as BaseApiClient } from "../../demo/src/lib/http.ts";

/** Local ApiClient: every entry id is percent-encoded before it reaches the
 * URL path, so a malformed id can never traverse into another route. */
export class ApiClient extends BaseApiClient {
  getEntry(id: string) {
    return super.getEntry(encodeURIComponent(id));
  }
  ready(id: string, commit: string) {
    return super.ready(encodeURIComponent(id), commit);
  }
  veto(id: string) {
    return super.veto(encodeURIComponent(id));
  }
}
