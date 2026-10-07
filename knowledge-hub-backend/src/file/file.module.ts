import { Module } from '@nestjs/common';
import { MineruModule } from '../mineru/mineru.module';
import { FileService } from './file.service';

@Module({
  imports: [MineruModule],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
