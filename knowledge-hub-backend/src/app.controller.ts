import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 健康检查（公开） */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
