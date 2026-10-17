import { Type } from 'class-transformer';
import { Equals, IsIn, IsNotEmpty, IsObject, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { WagerTransactionKind } from '../domain/wager-transaction';

export class MoneyDto {
  @IsString() @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString() @Equals('BRL')
  currency!: string;
}
export class CreateWalletDto {
  @IsUUID() playerId!: string;
  @IsObject() @ValidateNested() @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
export class CreateWagerDto {
  @IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(128) @Matches(/^(?!__internal__$)/)
  providerId!: string;
  @IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(128)
  externalTransactionId!: string;
  @IsUUID() playerId!: string;
  @IsUUID() walletId!: string;
  @IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(128)
  roundId!: string;
  @IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(128)
  gameId!: string;
  @IsIn([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss])
  kind!: WagerTransactionKind.Bet | WagerTransactionKind.Win | WagerTransactionKind.Loss;
  @IsObject() @ValidateNested() @Type(() => MoneyDto)
  money!: MoneyDto;
}
