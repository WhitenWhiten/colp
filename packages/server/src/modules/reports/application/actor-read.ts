import type { DigestSeries, DigestEdition } from '../domain/index.js';
export interface ReportReadActor { accountId:string;subjectId:string }
export interface ActorReportSeries { s:DigestSeries;member:boolean;memberRole:'owner'|'editor'|'viewer'|null;hidden:boolean;followed:boolean }
export interface ReportActorReadPort {
  series(actor:ReportReadActor,id:string):Promise<ActorReportSeries|null>;
  publishedEdition(actor:ReportReadActor,seriesId:string,id:string):Promise<DigestEdition|null>;
  hiddenPublishedEditionIds(ids:readonly string[]):Promise<Set<string>>;
  publishedCandidates(seriesId:string,limit:number,after?:{publishedAt:string;editionOrdinal:number;id:string}):Promise<readonly DigestEdition[]>;
}
