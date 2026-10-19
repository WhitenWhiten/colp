/**
 * Work taken one at a time, in the order it was asked for: each store's read-modify-write of a whole
 * record runs through one lane, so two changes never read the same value and write over each other.
 * A failed piece of work does not stop the next.
 */
export type Lane = <T>(work: () => Promise<T>) => Promise<T>;

export function createLane(): Lane {
  let lane: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = lane.then(work, work);
    lane = run.catch(() => undefined);
    return run;
  };
}
