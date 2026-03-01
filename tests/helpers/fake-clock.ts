// 時間模擬工具
export class FakeClock {
  private now: number;

  constructor(startTime: number = Date.now()) {
    this.now = startTime;
  }

  get currentTime(): number { return this.now; }
  advance(ms: number): void { this.now += ms; }
  set(time: number): void { this.now = time; }
  toDate(): Date { return new Date(this.now); }
  toISO(): string { return this.toDate().toISOString(); }
}
