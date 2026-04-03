import type { RelationshipType } from "../types";

/**
 * Sørensen–Dice coefficient on URL path segments.
 * Measures structural similarity between two URLs.
 */
export function diceScore(urlA: string, urlB: string): number {
  const segmentsA = urlA.split("/").filter(Boolean);
  const segmentsB = urlB.split("/").filter(Boolean);

  if (segmentsA.length === 0 && segmentsB.length === 0) return 1;
  if (segmentsA.length === 0 || segmentsB.length === 0) return 0;

  // Count shared prefix length
  let shared = 0;
  const minLen = Math.min(segmentsA.length, segmentsB.length);
  for (let i = 0; i < minLen; i++) {
    if (segmentsA[i] === segmentsB[i]) {
      shared++;
    } else {
      break;
    }
  }

  return (2 * shared) / (segmentsA.length + segmentsB.length);
}

/**
 * Compute a composite relatedness score from the three signals.
 */
export function compositeScore(
  isLinked: boolean,
  dice: number,
  semantic: number
): number {
  return (isLinked ? 0.5 : 0) + 0.3 * dice + 0.2 * semantic;
}

/**
 * Determine the dominant relationship type based on signal values.
 * Precedence: outgoing_link > incoming_link > sibling (dice > 0.4) > semantic
 */
export function dominantRelationshipType(
  isOutgoing: boolean,
  isIncoming: boolean,
  dice: number
): RelationshipType {
  if (isOutgoing) return "outgoing_link";
  if (isIncoming) return "incoming_link";
  if (dice > 0.4) return "sibling";
  return "semantic";
}
