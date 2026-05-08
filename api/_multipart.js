const parseContentDisposition = (value = '') => {
  const result = {};
  for (const part of value.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawValue) continue;
    result[rawKey.trim().toLowerCase()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return result;
};

const parseMultipartForm = (buffer, contentType) => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) return { fields: {}, file: null, files: [] };

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const segments = buffer.toString('latin1').split(`--${boundary}`);
  const fields = {};
  const files = [];

  for (const segment of segments) {
    const trimmed = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!trimmed || trimmed === '--') continue;

    const splitIndex = trimmed.indexOf('\r\n\r\n');
    if (splitIndex === -1) continue;

    const headerLines = trimmed.slice(0, splitIndex).split('\r\n');
    const value = trimmed.slice(splitIndex + 4).replace(/\r\n$/, '');
    const headers = {};

    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;

    if (disposition.filename) {
      files.push({
        fieldName: disposition.name,
        filename: disposition.filename,
        contentType: headers['content-type'] || 'text/plain',
        content: value,
      });
    } else {
      fields[disposition.name] = value;
    }
  }

  return { fields, file: files[0] || null, files };
};

module.exports = { parseMultipartForm };
