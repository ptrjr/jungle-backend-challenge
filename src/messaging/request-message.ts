import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import { Equals, IsISO8601, IsNotEmpty, IsObject, IsString, Matches, MaxLength, ValidateIf, ValidateNested, validateSync } from 'class-validator';
import { CreateWagerDto } from '../http/dto';

class SqsWagerDto extends CreateWagerDto {
  @IsString() @IsNotEmpty() @MaxLength(256) @Matches(/^\S(?:.*\S)?$/)
  idempotencyKey!: string;
}
export class RequestedWagerMessage {
  @IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(128)
  messageId!: string;
  @Equals('WagerTransactionRequested')
  type!: string;
  @IsISO8601({ strict: true })
  occurredAt!: string;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(128)
  correlationId?: string;
  @IsObject() @ValidateNested() @Type(() => SqsWagerDto)
  data!: SqsWagerDto;
}

export function parseRequestedMessage(body: string | undefined): RequestedWagerMessage {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const message = plainToInstance(RequestedWagerMessage, parsed);
    if (validateSync(message, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).length) throw new Error();
    return message;
  } catch { throw new BadRequestException({ code: 'MALFORMED_SQS_REQUEST' }); }
}
