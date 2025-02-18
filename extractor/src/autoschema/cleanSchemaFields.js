export function cleanSchemaFields(fields) {
    return fields.map((f) => {
      if (f.children && f.children.length === 0) {
        delete f.children;
      } else if (f.children) {
        f.children = cleanSchemaFields(f.children);
      }
      return f;
    });
  }