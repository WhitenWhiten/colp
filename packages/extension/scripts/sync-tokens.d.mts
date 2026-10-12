export declare const tokensSourcePath: string;
export declare function extractRootBlock(css: string): string;
export declare function renderGeneratedTokens(sourceCss: string): string;
export declare function syncTokens(options: { source?: string; output: string }): Promise<string>;
