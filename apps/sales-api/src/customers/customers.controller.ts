import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { CustomerListResource, CustomerResource } from './customer.mapper.js';
import { CustomersService } from './customers.service.js';
import { CustomerParamsDto } from './dto/customer-params.dto.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto.js';

/**
 * Superficie mínima de la respuesta HTTP necesaria para publicar `Location`.
 * `header()` existe en Express y en Fastify, así que el controller no queda
 * atado a una plataforma concreta.
 */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * Endpoints públicos de clientes. La autenticación, el `X-Trace-Id` y el
 * envelope de errores los aplica la aplicación, no este controller.
 */
@Controller('v1/customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateCustomerDto,
    @Res({ passthrough: true }) response: HeaderWriter,
  ): Promise<CustomerResource> {
    const created = await this.customers.create(body);
    response.header('Location', `/v1/customers/${created.id}`);
    return created;
  }

  @Get()
  list(@Query() query: ListCustomersQueryDto): Promise<CustomerListResource> {
    return this.customers.list(query);
  }

  @Get(':customerId')
  findById(@Param() params: CustomerParamsDto): Promise<CustomerResource> {
    return this.customers.findById(params.customerId);
  }
}
