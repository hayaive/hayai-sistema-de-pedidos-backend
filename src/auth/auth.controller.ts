import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthUser, RequestWithAuth } from './auth.types';
import { CurrentUser, Public } from './decorators';
import { LoginDto, RefreshDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * `POST /api/v1/auth/login` — ARCHITECTURE.md §6.2.
   *
   * Con límite de intentos aparte del global: el login es el único endpoint
   * donde un ataque por diccionario tiene sentido.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Rotación del refresh token, con detección de reutilización. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: RequestWithAuth) {
    const raw = req.headers['x-device-id'];
    const deviceId = Array.isArray(raw) ? raw[0] : raw;
    return this.auth.refresh(dto.refreshToken, deviceId ? String(deviceId) : undefined);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
