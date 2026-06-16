import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/** How far Luna can chop from her feet (matches bot-tree MAX_DIG_REACH). */
export const AXE_REACH_BLOCKS = 4.5;
/** Extra blocks scanned above axe reach to find true tree tops. */
export const SCAN_ABOVE_AXE_REACH = 10;

function feetBlockY(bot: Bot): number {
  return Math.floor(bot.entity.position.y - 0.01) - 1;
}

/** Highest world Y to scan from the bot's current stand (axe reach + headroom). */
export function axeScanTopFromBot(bot: Bot): number {
  return feetBlockY(bot) + Math.ceil(AXE_REACH_BLOCKS) + SCAN_ABOVE_AXE_REACH;
}

/** Dynamic scan ceiling: profile height, measured trunk, and 10 blocks above axe. */
export function effectiveLogScanTopY(bot: Bot, tree: DetectedTree): number {
  const profileTop = tree.trunk.y + tree.maxScanHeight;
  const fromBot = axeScanTopFromBot(bot);
  const fromMeasured = tree.trunk.y + tree.measuredHeight + SCAN_ABOVE_AXE_REACH;
  return Math.max(profileTop, fromBot, fromMeasured);
}

export type TrunkShape = "1x1" | "2x2" | "branching";

export type TreeProfile = {
  id: string;
  label: string;
  logNames: string[];
  leafNames: string[];
  trunkShape: TrunkShape;
  typicalHeight: { min: number; max: number };
  giantMaxHeight?: number;
  scanRadius: number;
  giantScanRadius?: number;
  maxScanHeight: number;
  giantMaxScanHeight?: number;
  chopHint: string;
};

export type DetectedTree = {
  profile: TreeProfile;
  logType: string;
  trunk: Vec3;
  trunkShape: TrunkShape;
  trunkColumns: Vec3[];
  scanRadius: number;
  maxScanHeight: number;
  measuredHeight: number;
  estimatedLogs: number;
  leafType?: string;
  isGiant: boolean;
  description: string;
};

const TREE_PROFILES: TreeProfile[] = [
  {
    id: "oak",
    label: "Oak",
    logNames: ["oak_log"],
    leafNames: ["oak_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 4, max: 7 },
    scanRadius: 3,
    maxScanHeight: 12,
    chopHint: "straight 1×1 trunk, round leaf blob on top"
  },
  {
    id: "birch",
    label: "Birch",
    logNames: ["birch_log"],
    leafNames: ["birch_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 5, max: 7 },
    scanRadius: 3,
    maxScanHeight: 12,
    chopHint: "slim white trunk, small round canopy"
  },
  {
    id: "spruce",
    label: "Spruce",
    logNames: ["spruce_log"],
    leafNames: ["spruce_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 6, max: 10 },
    giantMaxHeight: 31,
    scanRadius: 2,
    giantScanRadius: 3,
    maxScanHeight: 14,
    giantMaxScanHeight: 34,
    chopHint: "pyramid leaves; small = 1×1 trunk, giant = 2×2 trunk"
  },
  {
    id: "jungle",
    label: "Jungle",
    logNames: ["jungle_log"],
    leafNames: ["jungle_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 10, max: 18 },
    scanRadius: 4,
    maxScanHeight: 22,
    chopHint: "tall trunk with a wide bushy canopy"
  },
  {
    id: "acacia",
    label: "Acacia",
    logNames: ["acacia_log"],
    leafNames: ["acacia_leaves"],
    trunkShape: "branching",
    typicalHeight: { min: 6, max: 10 },
    scanRadius: 4,
    maxScanHeight: 14,
    chopHint: "trunk bends sideways — logs may sit off-center"
  },
  {
    id: "dark_oak",
    label: "Dark oak",
    logNames: ["dark_oak_log"],
    leafNames: ["dark_oak_leaves"],
    trunkShape: "2x2",
    typicalHeight: { min: 5, max: 8 },
    scanRadius: 2,
    maxScanHeight: 12,
    chopHint: "always 2×2 trunk, thick canopy above"
  },
  {
    id: "cherry",
    label: "Cherry",
    logNames: ["cherry_log"],
    leafNames: ["cherry_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 5, max: 8 },
    scanRadius: 3,
    maxScanHeight: 12,
    chopHint: "pink blossom leaves, straight trunk"
  },
  {
    id: "mangrove",
    label: "Mangrove",
    logNames: ["mangrove_log", "mangrove_roots"],
    leafNames: ["mangrove_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 8, max: 14 },
    scanRadius: 4,
    maxScanHeight: 18,
    chopHint: "tall trunk with root blocks at the base"
  },
  {
    id: "azalea",
    label: "Azalea",
    logNames: ["oak_log"],
    leafNames: ["azalea_leaves", "flowering_azalea_leaves"],
    trunkShape: "1x1",
    typicalHeight: { min: 4, max: 8 },
    scanRadius: 3,
    maxScanHeight: 12,
    chopHint: "oak-log trunk with flowering azalea leaves"
  },
  {
    id: "crimson",
    label: "Crimson",
    logNames: ["crimson_stem"],
    leafNames: ["nether_wart_block", "shroomlight"],
    trunkShape: "1x1",
    typicalHeight: { min: 5, max: 12 },
    scanRadius: 3,
    maxScanHeight: 16,
    chopHint: "nether stem with wart blocks as foliage"
  },
  {
    id: "warped",
    label: "Warped",
    logNames: ["warped_stem"],
    leafNames: ["nether_wart_block", "shroomlight"],
    trunkShape: "1x1",
    typicalHeight: { min: 5, max: 12 },
    scanRadius: 3,
    maxScanHeight: 16,
    chopHint: "nether stem with wart blocks as foliage"
  }
];

const LOG_TO_PROFILE = new Map<string, TreeProfile>();
for (const profile of TREE_PROFILES) {
  for (const log of profile.logNames) {
    if (!LOG_TO_PROFILE.has(log)) {
      LOG_TO_PROFILE.set(log, profile);
    }
  }
}

export function isLogBlockName(name: string): boolean {
  return (
    name.endsWith("_log") ||
    name.endsWith("_stem") ||
    name === "mangrove_roots" ||
    name === "crimson_stem" ||
    name === "warped_stem" ||
    name === "mushroom_stem"
  );
}

export function isLeafBlockName(name: string): boolean {
  return (
    name.endsWith("_leaves") ||
    name === "nether_wart_block" ||
    name === "shroomlight" ||
    name === "mangrove_roots"
  );
}

export function profileForLog(logName: string): TreeProfile | null {
  return LOG_TO_PROFILE.get(logName) ?? null;
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function sameLogFamily(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const baseA = a.replace(/_log$|_stem$/, "");
  const baseB = b.replace(/_log$|_stem$/, "");
  return baseA === baseB;
}

function find2x2Cluster(positions: Vec3[]): Vec3[] | null {
  const set = new Set(positions.map(posKey));
  for (const a of positions) {
    const corners = [
      a,
      new Vec3(a.x + 1, a.y, a.z),
      new Vec3(a.x, a.y, a.z + 1),
      new Vec3(a.x + 1, a.y, a.z + 1)
    ];
    if (corners.every((c) => set.has(posKey(c)))) {
      return corners;
    }
  }
  return null;
}

function trunkCenter(columns: Vec3[]): Vec3 {
  const x = Math.round(columns.reduce((n, p) => n + p.x, 0) / columns.length);
  const y = columns[0]!.y;
  const z = Math.round(columns.reduce((n, p) => n + p.z, 0) / columns.length);
  return new Vec3(x, y, z);
}

function detectLeafType(bot: Bot, anchor: Vec3, profile: TreeProfile, radius: number): string | undefined {
  for (let x = -radius; x <= radius; x++) {
    for (let y = 0; y <= profile.maxScanHeight; y++) {
      for (let z = -radius; z <= radius; z++) {
        const block = bot.blockAt(anchor.offset(x, y, z));
        if (!block || block.name === "air") {
          continue;
        }
        if (profile.leafNames.includes(block.name)) {
          return block.name;
        }
      }
    }
  }
  return undefined;
}

function measureTree(
  bot: Bot,
  anchor: Vec3,
  logType: string,
  scanRadius: number,
  profileMaxHeight: number
): { height: number; logCount: number; minY: number; maxY: number } {
  let minY = anchor.y;
  let maxY = anchor.y;
  let logCount = 0;
  const ceiling = Math.max(anchor.y + profileMaxHeight, axeScanTopFromBot(bot));

  for (let x = -scanRadius; x <= scanRadius; x++) {
    for (let z = -scanRadius; z <= scanRadius; z++) {
      if (new Vec3(x, 0, z).distanceTo(new Vec3(0, 0, 0)) > scanRadius) {
        continue;
      }
      for (let y = anchor.y; y <= ceiling; y++) {
        const block = bot.blockAt(new Vec3(anchor.x + x, y, anchor.z + z));
        if (!block || !isLogBlockName(block.name) || !sameLogFamily(block.name, logType)) {
          continue;
        }
        logCount += 1;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return { height: maxY - minY + 1, logCount, minY, maxY };
}

function detectTrunkColumns(bot: Bot, start: Vec3, logType: string): { shape: TrunkShape; columns: Vec3[] } {
  const profile = profileForLog(logType);
  if (profile?.trunkShape === "branching") {
    return { shape: "branching", columns: [start.clone()] };
  }

  const baseLogs: Vec3[] = [];
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = start.y - 1; y <= start.y + 1; y++) {
        const block = bot.blockAt(new Vec3(start.x + x, y, start.z + z));
        if (!block || !isLogBlockName(block.name) || !sameLogFamily(block.name, logType)) {
          continue;
        }
        baseLogs.push(block.position.clone());
      }
    }
  }

  const unique = new Map<string, Vec3>();
  for (const pos of baseLogs) {
    unique.set(`${pos.x},${pos.z}`, new Vec3(pos.x, start.y, pos.z));
  }
  const columns = [...unique.values()];

  const cluster = find2x2Cluster(columns);
  if (cluster) {
    return { shape: "2x2", columns: cluster };
  }

  if (profile?.trunkShape === "2x2" && columns.length >= 2) {
    return { shape: "2x2", columns };
  }

  return { shape: "1x1", columns: [new Vec3(start.x, start.y, start.z)] };
}

function refineProfile(
  bot: Bot,
  anchor: Vec3,
  logType: string,
  baseProfile: TreeProfile
): TreeProfile {
  if (logType === "oak_log") {
    const leaf = detectLeafType(bot, anchor, baseProfile, 4);
    if (leaf === "flowering_azalea_leaves" || leaf === "azalea_leaves") {
      return TREE_PROFILES.find((p) => p.id === "azalea") ?? baseProfile;
    }
    return TREE_PROFILES.find((p) => p.id === "oak") ?? baseProfile;
  }
  return baseProfile;
}

function buildDescription(
  profile: TreeProfile,
  trunkShape: TrunkShape,
  measuredHeight: number,
  estimatedLogs: number,
  leafType?: string,
  isGiant?: boolean
): string {
  const shape =
    trunkShape === "2x2" ? "2×2 trunk" : trunkShape === "branching" ? "branching trunk" : "1×1 trunk";
  const height =
    isGiant && profile.giantMaxHeight
      ? `~${measuredHeight} blocks tall (giant, up to ${profile.giantMaxHeight})`
      : `~${measuredHeight} blocks tall (usually ${profile.typicalHeight.min}–${profile.typicalHeight.max})`;
  const leaf = leafType ? leafType.replace(/_/g, " ") : profile.leafNames[0]?.replace(/_/g, " ") ?? "leaves";
  return `${profile.label} tree — ${shape}, ${height}, ${leaf} canopy. ${profile.chopHint}`;
}

/** Inspect a log block and learn tree type, trunk shape, height, and leaf pattern. */
export function detectTree(bot: Bot, logBlock: Block): DetectedTree | null {
  if (!isLogBlockName(logBlock.name)) {
    return null;
  }

  const baseProfile = profileForLog(logBlock.name);
  if (!baseProfile) {
    return null;
  }

  const anchor = logBlock.position.clone();
  let profile = refineProfile(bot, anchor, logBlock.name, baseProfile);
  const { shape, columns } = detectTrunkColumns(bot, anchor, logBlock.name);
  const trunk = trunkCenter(columns);

  let trunkShape = shape;
  if (profile.trunkShape === "2x2" && shape === "1x1" && columns.length >= 4) {
    trunkShape = "2x2";
  } else if (profile.trunkShape === "2x2") {
    trunkShape = "2x2";
  } else if (profile.trunkShape === "branching") {
    trunkShape = "branching";
  }

  const preScanRadius =
    trunkShape === "2x2"
      ? (profile.giantScanRadius ?? profile.scanRadius)
      : profile.scanRadius;
  const preMaxHeight = profile.giantMaxScanHeight ?? profile.maxScanHeight;
  const measured = measureTree(bot, trunk, logBlock.name, preScanRadius, preMaxHeight);

  const isGiant =
    profile.id === "spruce" &&
    (trunkShape === "2x2" || measured.height > profile.typicalHeight.max + 2);

  const scanRadius = isGiant
    ? (profile.giantScanRadius ?? profile.scanRadius)
    : trunkShape === "2x2"
      ? Math.max(profile.scanRadius, 2)
      : profile.scanRadius;
  const maxScanHeight = Math.max(
    isGiant
      ? (profile.giantMaxScanHeight ?? profile.maxScanHeight)
      : profile.maxScanHeight,
    measured.maxY - trunk.y + SCAN_ABOVE_AXE_REACH,
    axeScanTopFromBot(bot) - trunk.y
  );

  const leafType = detectLeafType(bot, trunk, profile, scanRadius);
  const description = buildDescription(
    profile,
    trunkShape,
    measured.height,
    measured.logCount,
    leafType,
    isGiant
  );

  return {
    profile,
    logType: logBlock.name,
    trunk,
    trunkShape,
    trunkColumns: columns,
    scanRadius,
    maxScanHeight,
    measuredHeight: measured.height,
    estimatedLogs: measured.logCount,
    leafType,
    isGiant,
    description
  };
}

export function scanTreeLogs(
  bot: Bot,
  tree: DetectedTree,
  minY?: number
): Vec3[] {
  const anchor = tree.trunk;
  const baseY = minY ?? anchor.y - 12;
  const seen = new Set<string>();
  const logs: Vec3[] = [];
  const r = tree.scanRadius;
  const topY = effectiveLogScanTopY(bot, tree);

  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      if (new Vec3(x, 0, z).distanceTo(new Vec3(0, 0, 0)) > r) {
        continue;
      }
      for (let y = baseY; y <= topY; y++) {
        const block = bot.blockAt(new Vec3(anchor.x + x, y, anchor.z + z));
        if (!block || !isLogBlockName(block.name) || !sameLogFamily(block.name, tree.logType)) {
          continue;
        }
        const key = posKey(block.position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        logs.push(block.position.clone());
      }
    }
  }

  return logs.sort((a, b) => a.y - b.y);
}

export function isTreeLeafBlock(block: Block, tree: DetectedTree): boolean {
  if (!block || block.name === "air") {
    return false;
  }
  if (tree.profile.leafNames.includes(block.name)) {
    return true;
  }
  return block.name.endsWith("_leaves");
}

/** Snow layers on snowy-biome trees, plus leaves that block the trunk. */
export function isTrunkFoliageBlock(block: Block, tree: DetectedTree): boolean {
  if (!block || block.name === "air") {
    return false;
  }
  if (block.name === "snow" || block.name === "snow_block") {
    return true;
  }
  return isTreeLeafBlock(block, tree);
}

/** Leaf blocks on and beside trunk columns (low spruce foliage, etc.). */
export function scanTrunkLeaves(bot: Bot, tree: DetectedTree): Vec3[] {
  const baseY = tree.trunk.y;
  const maxY = effectiveLogScanTopY(bot, tree);
  const seen = new Set<string>();
  const leaves: Vec3[] = [];
  const pad = tree.trunkShape === "2x2" ? 1 : 1;

  const columns =
    tree.trunkColumns.length > 0 ? tree.trunkColumns : [tree.trunk];

  for (const col of columns) {
    for (let dx = -pad; dx <= pad; dx++) {
      for (let dz = -pad; dz <= pad; dz++) {
        for (let y = baseY; y <= maxY; y++) {
          const pos = new Vec3(col.x + dx, y, col.z + dz);
          const key = posKey(pos);
          if (seen.has(key)) {
            continue;
          }
          const block = bot.blockAt(pos);
          if (!block || !isTrunkFoliageBlock(block, tree)) {
            continue;
          }
          seen.add(key);
          leaves.push(pos.clone());
        }
      }
    }
  }

  return leaves.sort((a, b) => a.y - b.y);
}

export function countLeavesNear(bot: Bot, tree: DetectedTree): number {
  const anchor = tree.trunk;
  let count = 0;
  const r = tree.scanRadius + 1;
  const maxY = effectiveLogScanTopY(bot, tree) - anchor.y;

  for (let x = -r; x <= r; x++) {
    for (let y = 0; y <= maxY; y++) {
      for (let z = -r; z <= r; z++) {
        const block = bot.blockAt(anchor.offset(x, y, z));
        if (!block || block.name === "air") {
          continue;
        }
        if (tree.profile.leafNames.includes(block.name)) {
          count += 1;
        }
      }
    }
  }
  return count;
}

export function preferredStandColumn(tree: DetectedTree): Vec3 {
  return tree.trunkColumns[0] ?? tree.trunk;
}

const LOG_TO_SAPLING: Record<string, string> = {
  oak_log: "oak_sapling",
  birch_log: "birch_sapling",
  spruce_log: "spruce_sapling",
  jungle_log: "jungle_sapling",
  acacia_log: "acacia_sapling",
  dark_oak_log: "dark_oak_sapling",
  cherry_log: "cherry_sapling",
  mangrove_log: "mangrove_propagule"
};

/** Chest item to replant this tree type (null for nether stems, etc.). */
export function saplingItemForTree(tree: DetectedTree): string | null {
  return LOG_TO_SAPLING[tree.logType] ?? null;
}

/** How many saplings to withdraw for a full replant. */
export function saplingsNeededForTree(tree: DetectedTree): number {
  if (tree.trunkShape !== "2x2") {
    return 1;
  }
  const unique = new Set(tree.trunkColumns.map((c) => `${c.x},${c.z}`));
  return Math.max(unique.size, 4);
}

/** Air-block positions where saplings should be placed (one per trunk column). */
export function treePlantSites(tree: DetectedTree): Vec3[] {
  const baseY = tree.trunk.y;
  const seen = new Set<string>();
  const sites: Vec3[] = [];

  const add = (x: number, z: number) => {
    const key = `${x},${z}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    sites.push(new Vec3(x, baseY, z));
  };

  if (tree.trunkShape === "2x2") {
    if (tree.trunkColumns.length >= 4) {
      for (const col of tree.trunkColumns) {
        add(col.x, col.z);
      }
    } else {
      const ax = tree.trunk.x;
      const az = tree.trunk.z;
      add(ax, az);
      add(ax + 1, az);
      add(ax, az + 1);
      add(ax + 1, az + 1);
    }
    return sites;
  }

  const col = preferredStandColumn(tree);
  add(col.x, col.z);
  return sites;
}
