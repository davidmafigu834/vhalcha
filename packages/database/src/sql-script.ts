export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarTag: string | null = null;
  let inSingleQuote = false;
  for (let index = 0; index < sqlText.length; index += 1) {
    const character = sqlText[index] ?? '';
    if (dollarTag) {
      if (sqlText.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += character;
      }
      continue;
    }
    if (inSingleQuote) {
      current += character;
      if (character === "'" && sqlText[index + 1] === "'") {
        current += "'";
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      current += character;
      continue;
    }
    if (character === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sqlText.slice(index));
      if (match?.[0]) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character === '-' && sqlText[index + 1] === '-') {
      const end = sqlText.indexOf('\n', index);
      const comment = end === -1 ? sqlText.slice(index) : sqlText.slice(index, end + 1);
      current += comment;
      index += comment.length - 1;
      continue;
    }
    if (character === ';') {
      if (statementHasSql(current)) {
        statements.push(current.trim());
      }
      current = '';
      continue;
    }
    current += character;
  }
  if (statementHasSql(current)) {
    statements.push(current.trim());
  }
  return statements;
}

function statementHasSql(statement: string) {
  return statement.replace(/--[^\n]*/g, '').trim().length > 0;
}

export function isDuplicateObject(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '42710');
}
