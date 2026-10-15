// Vocabulaire accepté par `_apply_arrete_core` (source unique côté robot). Module pur.
export const ESPECES = [
  'becasse', 'belette', 'blaireau', 'caille', 'canard', 'cerf', 'chamois', 'chevreuil', 'corbeau', 'corneille',
  'daim', 'etourneau', 'faisan', 'fouine', 'geai', 'isard', 'lapin', 'lievre', 'martre', 'mouflon',
  'palombe', 'perdrix', 'pie', 'putois', 'ragondin', 'rat_musque', 'renard', 'sanglier',
] as const

export const MODES = ['tous_modes', 'approche_affut', 'battue', 'tir', 'venerie_sous_terre', 'courre'] as const

// Sous-types présents en production ; la fonction SQL ne les contraint pas, le robot si.
export const SOUS_TYPES = ['cerf_elaphe', 'cerf_sika', 'perdrix_grise', 'perdrix_rouge'] as const
