import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DocumentModule } from './document/document.module';
import { MqModule } from './mq/mq.module';
import { EsModule } from './es/es.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { SearchModule } from './search/search.module';
import { KgModule } from './kg/kg.module';
import { AuthModule } from './auth/auth.module';
import { TeamModule } from './team/team.module';
import { RagModule } from './rag/rag.module';
import { AiModule } from './ai/ai.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_HOST', 'localhost'),
        port: Number(config.get('POSTGRES_PORT', 5432)),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        autoLoadEntities: true,
        // 表结构由 init-scripts/postgresql/init.sql 管理，不启用同步
        synchronize: false,
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get('MONGO_URI'),
      }),
    }),
    DocumentModule,
    AuthModule,
    TeamModule,
    MqModule,
    EsModule,
    PipelineModule,
    SearchModule,
    KgModule,
    RagModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
