/**
 * The result of asking one package manager a question.
 *
 * The whole point of this type is to keep "the scanner ran and found nothing"
 * distinct from "the scanner never ran". Both produce an empty list of
 * findings, and collapsing them means a clean repo on a machine without
 * Composer gets reported as unscannable — or, worse, an unscannable repo gets
 * reported as clean.
 */
export type EcosystemScan<T> =
  | { readonly status: 'ok'; readonly items: readonly T[] }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly hint: string;
    };

export const ok = <T>(items: readonly T[]): EcosystemScan<T> => ({
  status: 'ok',
  items,
});

export const unavailable = <T>(
  reason: string,
  hint: string,
): EcosystemScan<T> => ({ status: 'unavailable', reason, hint });
