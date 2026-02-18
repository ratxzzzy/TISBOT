import fs from "fs";
import path from "path";

export type MonitorState = {
  lastSeenTimestamp: number;
  seenTxHashes: string[]; // rolling window
};

const DEFAULT: MonitorState = { lastSeenTimestamp: 0, seenTxHashes: [] };

export class JsonStateStore {
  private file: string;
  constructor(filename = "monitor-state.json") {
    this.file = path.resolve(process.cwd(), filename);
  }

  load(): MonitorState {
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as MonitorState;
      if (
        !parsed ||
        typeof parsed.lastSeenTimestamp !== "number" ||
        !Array.isArray(parsed.seenTxHashes)
      )
        return DEFAULT;
      return parsed;
    } catch {
      return DEFAULT;
    }
  }

  save(state: MonitorState) {
    fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
  }
}
