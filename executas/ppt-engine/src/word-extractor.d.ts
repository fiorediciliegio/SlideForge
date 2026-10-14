declare module "word-extractor" {
  interface WordExtractorDocument {
    getBody(options?: { filterUnicode?: boolean }): string;
  }

  export default class WordExtractor {
    extract(source: Buffer): Promise<WordExtractorDocument>;
  }
}
