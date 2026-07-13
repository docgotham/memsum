export class DmsumError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DmsumError";
  }
}
