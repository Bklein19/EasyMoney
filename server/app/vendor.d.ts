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
