/** R5: room knowledge and consumed event projection are different facts. */
export class RevisionWatermarks {
  knownRoomRevision = 0;
  projectedThroughRevision = 0;

  reset(projectedThroughRevision: number, knownRoomRevision: number): void {
    this.projectedThroughRevision = projectedThroughRevision;
    this.knownRoomRevision = Math.max(
      projectedThroughRevision,
      knownRoomRevision,
    );
  }

  observeRoom(revision: number): number {
    this.knownRoomRevision = Math.max(this.knownRoomRevision, revision);
    return this.knownRoomRevision;
  }

  consumeProjection(revision: number): number {
    this.projectedThroughRevision = Math.max(
      this.projectedThroughRevision,
      revision,
    );
    this.observeRoom(revision);
    return this.projectedThroughRevision;
  }
}
