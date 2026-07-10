<?php

declare(strict_types=1);

namespace CleanFixture;

final class Database
{
    /**
     * Whether the connection answered its last ping.
     */
    public function isHealthy(): bool
    {
        return $this->lastPingSucceeded;
    }
}
