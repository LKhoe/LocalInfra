// The route pattern of the current page, built from usePathname() and useParams(): every
// segment that is a param value becomes its [name] ("/xadrez/AB12" → "/xadrez/[code]"), so no
// id, code or username ever leaves the browser. Copied from LocalInfra/templates/app/lib/metrics/.

type Params = Record<string, string | string[] | undefined> | null | undefined;

const STATIC = /^[A-Za-z0-9_\-.~]{1,40}$/;
// A static-looking segment that is really an id (a 404 for /recipes/123456, a token): hide it
const LOOKS_LIKE_ID = /\d{4,}|^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function toRoutePattern(pathname: string | null | undefined, params: Params): string {
  const segments = (pathname || "/").split("?")[0].split("#")[0].split("/").filter(Boolean).map(decode);
  const out: (string | null)[] = [...segments];

  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // catch-all: the run of segments equal to the values becomes one [...name]
      if (!value.length) continue;
      for (let i = 0; i + value.length <= segments.length; i++) {
        if (value.every((v, j) => decode(v) === segments[i + j] && out[i + j] === segments[i + j])) {
          out[i] = `[...${name}]`;
          for (let j = 1; j < value.length; j++) out[i + j] = null;
          break;
        }
      }
    } else {
      const v = decode(value);
      for (let i = 0; i < segments.length; i++) if (segments[i] === v && out[i] === segments[i]) out[i] = `[${name}]`;
    }
  }

  const clean = out
    .filter((s): s is string => s !== null)
    .map((s) => (s.startsWith("[") ? s.replace(/[^A-Za-z0-9_.[\]]/g, "") : STATIC.test(s) && !LOOKS_LIKE_ID.test(s) ? s : "[x]"))
    .slice(0, 8);
  return "/" + clean.join("/");
}
