import {
  MAX_SEMANTIC_NODES,
  utf8ByteLength,
  type ElementDescriptor,
  type ElementScope,
  type ElementSnapshot,
  type ElementView,
} from "@understudy/protocol";
import { semanticSearchKey } from "./normalize";
import type {
  NormalizedSemanticNode,
  RefRecord,
  SemanticCache,
  SemanticCapture,
} from "./types";
import { backendIdentityKey } from "./types";

const MAX_NORMALIZED_STRING_BYTES = 8 * 1024 * 1024;
const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);
const URGENT_ROLES = new Set(["dialog", "alertdialog", "alert", "status", "log"]);

function domOrder(left: NormalizedSemanticNode, right: NormalizedSemanticNode): number {
  return left.frameOrder - right.frameOrder || left.domOrder - right.domOrder;
}

function actionable(node: NormalizedSemanticNode): boolean {
  return node.descriptor.actions.some((action) => action !== "inspect");
}

function focused(node: NormalizedSemanticNode): boolean {
  return node.descriptor.states?.focused === true;
}

function priority(node: NormalizedSemanticNode): number {
  if (URGENT_ROLES.has(node.descriptor.role) || focused(node)) return 0;
  if (actionable(node) && node.descriptor.visibility === "viewport") return 1;
  if (node.descriptor.role === "heading" || LANDMARK_ROLES.has(node.descriptor.role)) return 2;
  if (actionable(node) && node.descriptor.visibility === "unknown") return 3;
  if (actionable(node)) return 4;
  if (node.descriptor.category === "content" && node.descriptor.visibility === "viewport") return 5;
  return 6;
}

function pageStringBytes(node: NormalizedSemanticNode): number {
  const strings = [
    node.descriptor.role,
    node.descriptor.name,
    node.descriptor.description,
    node.descriptor.states?.hasPopup,
    node.descriptor.form?.inputType,
    node.descriptor.form?.placeholder,
    node.descriptor.form?.autocomplete,
    node.descriptor.range?.text,
    node.searchName,
    node.searchDescription,
    node.searchPlaceholder,
    node.searchAutocomplete,
    node.fingerprint.tagName,
    node.fingerprint.inputType,
  ];
  return strings.reduce(
    (total, value) => total + (value === undefined ? 0 : utf8ByteLength(value)),
    0,
  );
}

function selectBoundedNodes(
  input: readonly NormalizedSemanticNode[],
): { nodes: NormalizedSemanticNode[]; truncated: boolean } {
  const byIdentity = new Map(input.map((node) => [node.identity, node]));
  const indexByIdentity = new Map(input.map((node, index) => [node.identity, index]));
  const parentIndexes = input.map((node) =>
    node.parentIdentity === undefined
      ? -1
      : (indexByIdentity.get(node.parentIdentity) ?? -1),
  );
  const depths = new Array<number>(input.length).fill(0);
  const cumulativeBytes = new Array<number>(input.length).fill(0);
  for (let index = 0; index < input.length; index += 1) {
    const parentIndex = parentIndexes[index]!;
    depths[index] = parentIndex < 0 ? 0 : depths[parentIndex]! + 1;
    cumulativeBytes[index] =
      (parentIndex < 0 ? 0 : cumulativeBytes[parentIndex]!) +
      pageStringBytes(input[index]!);
  }
  const ancestorLevels: number[][] = [parentIndexes];
  for (
    let distance = 2;
    distance <= input.length;
    distance *= 2
  ) {
    const previous = ancestorLevels.at(-1)!;
    ancestorLevels.push(
      previous.map((ancestor) => (ancestor < 0 ? -1 : previous[ancestor]!)),
    );
  }
  const ancestorAt = (start: number, distance: number): number => {
    let current = start;
    let remaining = distance;
    let level = 0;
    while (remaining > 0 && current >= 0) {
      if ((remaining & 1) === 1) current = ancestorLevels[level]![current]!;
      remaining = Math.floor(remaining / 2);
      level += 1;
    }
    return current;
  };
  const selected = new Map<string, NormalizedSemanticNode>();
  const selectedIndexes = new Set<number>();
  let stringBytes = 0;
  const candidates = [...input].sort(
    (left, right) => priority(left) - priority(right) || domOrder(left, right),
  );

  for (const candidate of candidates) {
    if (selected.has(candidate.identity)) continue;
    const candidateIndex = indexByIdentity.get(candidate.identity)!;
    const rootIndex = ancestorAt(candidateIndex, depths[candidateIndex]!);
    let boundaryIndex = -1;
    let chainLength = depths[candidateIndex]! + 1;
    if (rootIndex >= 0 && selectedIndexes.has(rootIndex)) {
      let low = 1;
      let high = depths[candidateIndex]!;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const ancestor = ancestorAt(candidateIndex, middle);
        if (ancestor >= 0 && selectedIndexes.has(ancestor)) high = middle;
        else low = middle + 1;
      }
      chainLength = low;
      boundaryIndex = ancestorAt(candidateIndex, low);
    }
    const addedBytes =
      cumulativeBytes[candidateIndex]! -
      (boundaryIndex < 0 ? 0 : cumulativeBytes[boundaryIndex]!);
    if (
      selected.size + chainLength > MAX_SEMANTIC_NODES ||
      stringBytes + addedBytes > MAX_NORMALIZED_STRING_BYTES
    ) {
      continue;
    }
    const chainIndexes: number[] = [];
    let currentIndex = candidateIndex;
    while (currentIndex >= 0 && currentIndex !== boundaryIndex) {
      chainIndexes.push(currentIndex);
      currentIndex = parentIndexes[currentIndex]!;
    }
    chainIndexes.reverse();
    for (const index of chainIndexes) {
      const node = input[index]!;
      selected.set(node.identity, node);
      selectedIndexes.add(index);
    }
    stringBytes += addedBytes;
  }

  const nodes = [...selected.values()].sort(domOrder);
  const retained = new Set(nodes.map((node) => node.identity));
  for (const node of nodes) {
    let parentIdentity = node.parentIdentity;
    while (parentIdentity !== undefined && !retained.has(parentIdentity)) {
      parentIdentity = byIdentity.get(parentIdentity)?.parentIdentity;
    }
    node.parentIdentity = parentIdentity;
    node.childIdentities = node.childIdentities.filter((identity) => retained.has(identity));
  }
  return { nodes, truncated: nodes.length !== input.length };
}

function frozenNode(node: NormalizedSemanticNode): NormalizedSemanticNode {
  const descriptor = Object.freeze({
    ...node.descriptor,
    actions: Object.freeze([...node.descriptor.actions]),
    ...(node.descriptor.states === undefined
      ? {}
      : { states: Object.freeze({ ...node.descriptor.states }) }),
    ...(node.descriptor.form === undefined
      ? {}
      : { form: Object.freeze({ ...node.descriptor.form }) }),
    ...(node.descriptor.range === undefined
      ? {}
      : { range: Object.freeze({ ...node.descriptor.range }) }),
    ...(node.descriptor.bounds === undefined
      ? {}
      : { bounds: Object.freeze({ ...node.descriptor.bounds }) }),
  });
  return Object.freeze({
    ...node,
    childIdentities: Object.freeze([...node.childIdentities]) as unknown as string[],
    descriptor,
    fingerprint: Object.freeze({ ...node.fingerprint }),
  }) as unknown as NormalizedSemanticNode;
}

export function buildSemanticCache(
  capture: SemanticCapture,
  snapshot: ElementSnapshot,
  refPrefix: string,
): { cache: SemanticCache; refMap: Map<string, RefRecord> } {
  const selected = selectBoundedNodes(capture.nodes);
  const nodes = selected.nodes.map(frozenNode);
  const refByIdentity = new Map<string, string>();
  const refMap = new Map<string, RefRecord>();
  let sequence = 0;
  for (const node of nodes) {
    if (node.backendNodeId === undefined) continue;
    const ref = `${refPrefix}${sequence++}`;
    refByIdentity.set(node.identity, ref);
    refMap.set(ref, {
      backendNodeId: node.backendNodeId,
      frameId: node.frameId,
      ...(node.debuggerSessionId === undefined
        ? {}
        : { debuggerSessionId: node.debuggerSessionId }),
      generation: snapshot.generation,
      actions: new Set(node.descriptor.actions),
      fingerprint: node.fingerprint,
      identity: node.identity,
    });
  }
  const effectiveSnapshot = Object.freeze({
    ...snapshot,
    coverage:
      capture.coverage === "partial" || selected.truncated ? "partial" : "complete",
  }) satisfies ElementSnapshot;
  const cache: SemanticCache = Object.freeze({
    snapshot: effectiveSnapshot,
    loaderId: capture.loaderId,
    url: capture.url,
    topologyKey: capture.topologyKey,
    nodes: Object.freeze(nodes),
    byIdentity: new Map(nodes.map((node) => [node.identity, node])),
    byBackendIdentity: new Map(
      nodes.flatMap((node) =>
        node.backendNodeId === undefined
          ? []
          : [[backendIdentityKey(node.debuggerSessionId, node.backendNodeId), node] as const],
      ),
    ),
    refByIdentity,
  });
  return { cache, refMap };
}

function descriptor(
  cache: SemanticCache,
  node: NormalizedSemanticNode,
  options: {
    includeBounds?: boolean;
    relation?: ElementDescriptor["relation"];
    change?: ElementDescriptor["change"];
    omitRef?: boolean;
    override?: Partial<ElementDescriptor>;
    omitFields?: ReadonlyArray<
      "name" | "description" | "states" | "form" | "range" | "bounds"
    >;
  } = {},
): ElementDescriptor {
  const { bounds, ...base } = node.descriptor;
  const ref = options.omitRef ? undefined : cache.refByIdentity.get(node.identity);
  const output: ElementDescriptor = {
    ...base,
    ...(options.includeBounds === true && bounds !== undefined ? { bounds } : {}),
    ...(ref === undefined ? {} : { ref }),
    ...(options.relation === undefined ? {} : { relation: options.relation }),
    ...(options.change === undefined ? {} : { change: options.change }),
    ...options.override,
  };
  for (const field of options.omitFields ?? []) delete output[field];
  return output;
}

function ancestorIdentities(
  cache: SemanticCache,
  node: NormalizedSemanticNode,
): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let identity = node.parentIdentity;
  while (identity !== undefined && !seen.has(identity)) {
    seen.add(identity);
    ancestors.push(identity);
    identity = cache.byIdentity.get(identity)?.parentIdentity;
  }
  return ancestors;
}

function includeForView(node: NormalizedSemanticNode, view: ElementView): boolean {
  if (view === "all") return true;
  if (view === "content") {
    return node.descriptor.category !== "structure" || URGENT_ROLES.has(node.descriptor.role);
  }
  return actionable(node) || URGENT_ROLES.has(node.descriptor.role) || focused(node);
}

function includeForScope(node: NormalizedSemanticNode, scope: ElementScope): boolean {
  if (node.descriptor.visibility === "hidden") return false;
  return scope === "document" || node.descriptor.visibility !== "offscreen";
}

function projectionPriority(
  node: NormalizedSemanticNode,
  focusedPath: ReadonlySet<string>,
): number {
  if (
    URGENT_ROLES.has(node.descriptor.role) ||
    focused(node) ||
    focusedPath.has(node.identity)
  ) {
    return 0;
  }
  if (actionable(node) && node.descriptor.visibility === "viewport") return 1;
  if (node.descriptor.role === "heading" || LANDMARK_ROLES.has(node.descriptor.role)) return 2;
  if (actionable(node) && node.descriptor.visibility === "unknown") return 3;
  return 4;
}

export function snapshotDescriptors(
  cache: SemanticCache,
  scope: ElementScope,
  view: ElementView,
): ElementDescriptor[] {
  const selected = new Map<string, NormalizedSemanticNode>();
  const focusedPath = new Set<string>();
  for (const node of cache.nodes) {
    if (!includeForView(node, view) || !includeForScope(node, scope)) continue;
    selected.set(node.identity, node);
    if (focused(node)) {
      for (const ancestorIdentity of ancestorIdentities(cache, node)) {
        const ancestor = cache.byIdentity.get(ancestorIdentity);
        if (ancestor !== undefined) {
          selected.set(ancestor.identity, ancestor);
          focusedPath.add(ancestor.identity);
        }
      }
    }
    if (view !== "interactive") continue;
    for (const ancestorIdentity of ancestorIdentities(cache, node)) {
      const ancestor = cache.byIdentity.get(ancestorIdentity);
      if (
        ancestor !== undefined &&
        (ancestor.descriptor.role === "heading" ||
          LANDMARK_ROLES.has(ancestor.descriptor.role) ||
          URGENT_ROLES.has(ancestor.descriptor.role))
      ) {
        selected.set(ancestor.identity, ancestor);
      }
    }
  }
  return [...selected.values()]
    .sort(
      (left, right) =>
        projectionPriority(left, focusedPath) -
          projectionPriority(right, focusedPath) ||
        domOrder(left, right),
    )
    .map((node) => descriptor(cache, node));
}

function matchRank(
  node: NormalizedSemanticNode,
  query: string,
  match: "contains" | "exact",
): number | undefined {
  const name = node.searchName;
  if (name === query) return 0;
  if (match === "contains" && name?.startsWith(query)) return 1;
  if (match === "contains" && name?.includes(query)) return 2;
  const secondary = [
    node.searchDescription,
    node.searchPlaceholder,
    node.searchAutocomplete,
  ];
  if (secondary.some((value) => value === query)) return 3;
  if (match === "contains" && secondary.some((value) => value?.includes(query))) return 4;
  return undefined;
}

export function findDescriptors(
  cache: SemanticCache,
  input: {
    query: string;
    roles: readonly string[];
    match: "contains" | "exact";
    includeHidden: boolean;
  },
): ElementDescriptor[] {
  const query = semanticSearchKey(input.query);
  if (query === undefined) return [];
  const roles = new Set(input.roles);
  const matches = cache.nodes
    .map((node) => ({ node, rank: matchRank(node, query, input.match) }))
    .filter(
      (candidate): candidate is { node: NormalizedSemanticNode; rank: number } =>
        candidate.rank !== undefined &&
        (roles.size === 0 || roles.has(candidate.node.descriptor.role)) &&
        (input.includeHidden || candidate.node.descriptor.visibility !== "hidden"),
    )
    .sort((left, right) => left.rank - right.rank || domOrder(left.node, right.node));

  const relations = new Map<
    string,
    { node: NormalizedSemanticNode; relation: NonNullable<ElementDescriptor["relation"]> }
  >();
  const put = (
    node: NormalizedSemanticNode,
    relation: NonNullable<ElementDescriptor["relation"]>,
  ): void => {
    const existing = relations.get(node.identity);
    if (existing === undefined || relation === "match") relations.set(node.identity, { node, relation });
  };

  for (const { node } of matches) {
    const ancestors = ancestorIdentities(cache, node).slice(0, 4).reverse();
    for (const identity of ancestors) {
      const ancestor = cache.byIdentity.get(identity);
      if (ancestor !== undefined) put(ancestor, "ancestor");
    }
    if (node.parentIdentity !== undefined) {
      const parent = cache.byIdentity.get(node.parentIdentity);
      const siblings = parent?.childIdentities ?? [];
      const index = siblings.indexOf(node.identity);
      for (const siblingIndex of [index - 1, index + 1]) {
        const sibling = cache.byIdentity.get(siblings[siblingIndex] ?? "");
        if (sibling !== undefined) put(sibling, "sibling");
      }
    }
    put(node, "match");
  }
  const matchOrder = new Map(
    matches.map(({ node }, index) => [node.identity, index]),
  );
  return [...relations.values()]
    .sort((left, right) => {
      if (left.relation === "match" && right.relation === "match") {
        return (
          (matchOrder.get(left.node.identity) ?? Number.MAX_SAFE_INTEGER) -
          (matchOrder.get(right.node.identity) ?? Number.MAX_SAFE_INTEGER)
        );
      }
      if (left.relation === "match") return -1;
      if (right.relation === "match") return 1;
      return domOrder(left.node, right.node);
    })
    .map(({ node, relation }) => descriptor(cache, node, { relation }));
}

export function inspectDescriptors(
  cache: SemanticCache,
  target: NormalizedSemanticNode,
  input: {
    depth: number;
    includeBounds: boolean;
    targetOverride?: Partial<ElementDescriptor>;
    omitTargetFields?: ReadonlyArray<
      "name" | "description" | "states" | "form" | "range" | "bounds"
    >;
  },
): ElementDescriptor[] {
  const output: ElementDescriptor[] = [];
  output.push(
    descriptor(cache, target, {
      includeBounds: input.includeBounds,
      relation: "match",
      override: input.targetOverride,
      omitFields: input.omitTargetFields,
    }),
  );
  const ancestors = ancestorIdentities(cache, target).reverse();
  for (const identity of ancestors) {
    const ancestor = cache.byIdentity.get(identity);
    if (ancestor !== undefined) {
      output.push(
        descriptor(cache, ancestor, {
          includeBounds: input.includeBounds,
          relation: "ancestor",
        }),
      );
    }
  }
  const queue = target.childIdentities.map((identity) => ({ identity, depth: 1 }));
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!;
    if (current.depth > input.depth) continue;
    const node = cache.byIdentity.get(current.identity);
    if (node === undefined) continue;
    output.push(
      descriptor(cache, node, {
        includeBounds: input.includeBounds,
        relation: "descendant",
      }),
    );
    for (const identity of node.childIdentities) {
      queue.push({ identity, depth: current.depth + 1 });
    }
  }
  return output;
}

function semanticFingerprint(node: NormalizedSemanticNode): string {
  const { bounds: _bounds, depth: _depth, ...descriptorWithoutLayout } = node.descriptor;
  return JSON.stringify({ descriptorWithoutLayout, fingerprint: node.fingerprint });
}

export function deltaDescriptors(
  previous: SemanticCache,
  current: SemanticCache,
): {
  elements: ElementDescriptor[];
  added: number;
  changed: number;
  removed: number;
} {
  const added: NormalizedSemanticNode[] = [];
  const changed: NormalizedSemanticNode[] = [];
  const removed: NormalizedSemanticNode[] = [];
  for (const node of current.nodes) {
    const prior = previous.byIdentity.get(node.identity);
    if (prior === undefined) added.push(node);
    else if (semanticFingerprint(prior) !== semanticFingerprint(node)) changed.push(node);
  }
  for (const node of previous.nodes) {
    if (!current.byIdentity.has(node.identity)) removed.push(node);
  }

  const changedIdentities = new Set(
    [...added, ...changed].map((node) => node.identity),
  );
  const context = new Map<string, NormalizedSemanticNode>();
  for (const node of [...added, ...changed]) {
    for (const identity of ancestorIdentities(current, node)) {
      if (!changedIdentities.has(identity)) {
        const ancestor = current.byIdentity.get(identity);
        if (ancestor !== undefined) context.set(identity, ancestor);
      }
    }
  }
  const elements = [
    ...[...context.values()]
      .sort(domOrder)
      .map((node) => descriptor(current, node, { change: "unchanged_context" })),
    ...added.sort(domOrder).map((node) => descriptor(current, node, { change: "added" })),
    ...changed.sort(domOrder).map((node) => descriptor(current, node, { change: "changed" })),
    ...removed
      .sort(domOrder)
      .map((node) => descriptor(previous, node, { change: "removed", omitRef: true })),
  ];
  return {
    elements,
    added: added.length,
    changed: changed.length,
    removed: removed.length,
  };
}
