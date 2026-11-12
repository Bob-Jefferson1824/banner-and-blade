# Class roster: existing classes versus the planned roster

Nothing is substituted. This document records how what exists relates to what is planned, so no one has to guess.

## Planned roster (required)
Knight, Archer, Spearman, **Cavalry**, **Guard**.

## What exists in the game today (from the code, `CLASSES` in the simulation)
| Existing class | Loadout | HP | Speed | Armor factor | Shield |
|---|---|---|---|---|---|
| Knight | sword (or axe) + shield; defensive frontline | 140 | 0.90 | 0.80 | yes |
| Archer | longbow, light armour | 90 | 1.04 | 1.00 | no |
| Spearman | spear + light shield, long reach | 125 | 0.98 | 0.85 | yes |
| Crossbowman | crossbow, heavy bolts, long reload | 105 | 0.96 | 0.90 | no |
| Scout | twin knives, fast skirmisher | 95 | 1.17 | 1.00 | no |

## Relationship between existing and planned
| Planned class | Relationship to what exists | Work needed |
|---|---|---|
| Knight | **Exists** (same name, same role: sword and shield) | none beyond roster/unlock wiring |
| Archer | **Exists** (bow and arrows) | none beyond roster/unlock wiring |
| Spearman | **Exists** (long-reach melee) | none beyond roster/unlock wiring |
| **Cavalry** | **Does not exist as a class.** Related pieces: single-player maps contain loose horses a soldier can take (E to mount, speed x1.8, horse has 160 HP, dismount with E). There is no cavalry loadout, no mounted attack/charge mechanic, no horse in the multiplayer snapshot, no horse model sync, and the AI does not ride by class. | New class, see plan below |
| **Guard** | **Does not exist as a class.** The nearest existing class is Knight (shield, high armour), but Knight is an offensive-defensive frontliner; there is no dedicated defensive-equipment class (large shield, brace/guard-stance mechanics, protecting allies). | New class, see plan below |

| Existing class not in the planned roster | Status |
|---|---|
| **Crossbowman** | Stays in the game exactly as it is. It is **not** a replacement for any planned class. Whether it joins the online/progression roster as an extra class, stays single-player/custom-battle only, or is retired is **your decision** (undecided). Until you decide, nothing is removed or changed. |
| **Scout** | Same as Crossbowman. |

Technical consequence: the class system is data-driven (class id -> loadout), and account unlocks store class ids, so the roster can be seven entries
(five planned + two existing extras) or five without any redesign. Starter unlocks per account are a design decision for Stage 4 (suggestion: Knight, Archer, Spearman unlocked from the start; others earned).

## Implementation plan: Cavalry (required)
1. **Design approval first (you):** loadout (e.g. lance/sword), charge damage and its dependence on speed, dismounted behaviour, horse HP and what happens when the horse dies, where mounted classes may go (no tight interiors, ladders, towers), counters (Spearman bonus against a charging horse), balance targets.
2. Simulation: horse as a per-soldier entity owned by the class (not a map pickup), mounted movement/steering with inertia, charge and trample hit rules, dismount/remount, horse damage and death, navigation limits, AI behaviour (flank, charge, retreat).
3. Server/network: add mount state and horse position/yaw to snapshots and events; server validates everything (no client-claimed charge damage).
4. Client: horse and rider models and animations, camera, HUD (horse HP), sounds.
5. Maps: check each map for mounted play (spawn space, obstacles); the open continent later needs the same rules.
6. Tests: unit/simulation tests, balance simulation runs against the other classes, multiplayer sync test, regression of single-player horses (existing behaviour must not change).

## Implementation plan: Guard (required)
1. **Design approval first (you):** equipment (e.g. tower shield + mace or short sword), defensive mechanics (wide block arc, shield-brace stance, reduced knockback, damage mitigation, possibly an aura or "cover" for nearby allies), speed/HP/armor targets, weaknesses (low damage, slow, vulnerable to flanking and ranged).
2. Simulation: new weapon/shield definitions and stance rules in the existing combat model (block, parry, stagger already exist), balance, AI behaviour (hold positions, escort objectives).
3. Server/network: stance state in snapshots; server-side validation.
4. Client: model, shield visuals and animations, HUD indicator for stance.
5. Tests: combat unit tests, balance simulation runs, multiplayer sync test.

Both classes are **required** parts of the roadmap (Stage 9b). The class-after-death feature (Stage 9c) is built after both exist so the death-screen roster is final.
