declare module 'papaparse' {
  const Papa: {
    parse<T = Record<string, string>>(input: string, options: Record<string, unknown>): {
      data: T[];
      errors: Array<{ type: string; message: string }>;
      meta: { fields?: string[] };
    };
  };

  export default Papa;
}

declare module '@napi-rs/canvas' {
  export class Canvas {}
  export interface SKRSContext2D {}
  export type CanvasRenderingContext2D = SKRSContext2D;
}
