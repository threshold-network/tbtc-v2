export const exchangeToInternalNameMap: Map<string, string> = new Map();

export async function convertSymbol(symbol: string, mode: string = "", symbolMode: string = ""): Promise<string> {
  let rSymbol: string;
  if (mode === "reverse") {
    for (const [key, value] of exchangeToInternalNameMap.entries()) {
      if (value === symbol) {
        return key;
      }
    }
    rSymbol = symbol;
  } else {
    rSymbol = exchangeToInternalNameMap.get(symbol) || symbol;
  }

  if (symbolMode === "SPOT") {
    if (!rSymbol.endsWith("-SPOT")) {
      rSymbol = symbol + "-SPOT";
    }
  } else if (symbolMode === "PERP") {
    if (!rSymbol.endsWith("-PERP")) {
      rSymbol = symbol + "-PERP";
    }
  }

  return rSymbol;
}

export async function convertSymbolsInObject(obj: any, symbolsFields: Array<string> = ["coin", "symbol"], symbolMode: string = ""): Promise<any> {
  if (typeof obj !== 'object' || obj === null) {
    return convertToNumber(obj);
  }

  if (Array.isArray(obj)) {
    return Promise.all(obj.map(item => convertSymbolsInObject(item, symbolsFields, symbolMode)));
  }

  const convertedObj: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (symbolsFields.includes(key)) {
      convertedObj[key] = await convertSymbol(value as string, "", symbolMode);
    } else if (key === 'side') {
      convertedObj[key] = value === 'A' ? 'sell' : value === 'B' ? 'buy' : value;
    } else {
      convertedObj[key] = await convertSymbolsInObject(value, symbolsFields, symbolMode);
    }
  }
  return convertedObj;
}

export function convertToNumber(value: any): any {
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) {
      return parseInt(value, 10);
    } else if (/^-?\d*\.\d+$/.test(value)) {
      return parseFloat(value);
    }
  }
  return value;
}

export async function convertResponse(
  response: any,
  symbolsFields: string[] = ["coin", "symbol"],
  symbolMode: string = ""
): Promise<any> {
  return convertSymbolsInObject(response, symbolsFields, symbolMode);
}
