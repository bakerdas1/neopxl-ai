function normalizeName(name) {
  return String(name || "").toLowerCase().trim();
}

function mergeField(existing, incoming) {
  if (!existing) return incoming;

  if (!existing.description && incoming.description) {
    existing.description = incoming.description;
  }

  const hasChildren = (f) => f.children && f.children.length > 0;
  if (hasChildren(existing) && hasChildren(incoming)) {
    existing.children = mergeSchemas(existing.children, incoming.children);
  } else if (!hasChildren(existing) && hasChildren(incoming)) {
    existing.children = incoming.children;
  } else if (hasChildren(existing) && !hasChildren(incoming)) {
    existing.children = cleanChildren(existing.children);
  }

  return existing;
}

function cleanChildren(children) {
  return (children || []).filter((c) => c && typeof c === "object");
}

export function mergeSchemas(...schemaArrays) {
  const byName = new Map();
  const order = [];

  for (const fields of schemaArrays) {
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      if (!field || typeof field.name !== "string" || !field.name.trim()) continue;
      const key = normalizeName(field.name);
      if (byName.has(key)) {
        byName.set(key, mergeField(byName.get(key), field));
      } else {
        const clone = { ...field };
        if (clone.children) clone.children = clone.children.map((c) => ({ ...c }));
        byName.set(key, clone);
        order.push(key);
      }
    }
  }

  return order.map((key) => byName.get(key));
}
