export type PotentialKind = "lj" | "wca";

export interface PotentialParams {
  kind: PotentialKind;
  epsilon: number;
  sigma: number;
  rCut: number;
}

export interface LineSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  epsilon: number;
  sigma: number;
}

export interface Domain {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface Diagnostics {
  step: number;
  time: number;
  kineticEnergy: number;
  potentialEnergy: number;
  totalEnergy: number;
  temperature: number;
  momentumX: number;
  momentumY: number;
}
