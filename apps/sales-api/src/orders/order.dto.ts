import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderCreateItemDto {
  @IsUUID()
  partId!: string;

  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;
}

export class OrderCreateDto {
  @IsUUID()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: OrderCreateItemDto) => item?.partId?.toLowerCase())
  @ValidateNested({ each: true })
  @Type(() => OrderCreateItemDto)
  items!: OrderCreateItemDto[];
}

export class OrderListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsIn(['CONFIRMED', 'CANCELLED'])
  status?: 'CONFIRMED' | 'CANCELLED';

  @IsOptional()
  @IsUUID()
  customerId?: string;
}