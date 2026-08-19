const MAX_DESC_WORDS = 20;

function capDescription(desc) {
  if (typeof desc !== 'string') return desc;
  const words = desc.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= MAX_DESC_WORDS) return words.join(' ');
  return words.slice(0, MAX_DESC_WORDS).join(' ') + '…';
}

function isContainer(f) {
  return f.type === 'object' || f.type === 'array';
}

export function cleanSchemaFields(fields) {
  return fields
    .map((f) => {
      if (f.description) f.description = capDescription(f.description);
      if (f.children && f.children.length) {
        f.children = cleanSchemaFields(f.children);
        if (f.children.length === 0) delete f.children;
      } else {
        delete f.children;
      }
      return f;
    })
    .filter((f) => !(isContainer(f) && (!f.children || f.children.length === 0)));
}
